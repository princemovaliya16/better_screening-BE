import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ActivityService, ActivityType } from '@module/activity';
import { Candidate } from '@module/candidates/entities';
import { OrganizationSettings } from '@module/organizations/entities';
import { LlmService } from '@core/llm';
import {
  EmploymentType,
  InterviewRoundTemplate,
  InterviewRoundType,
  Job,
  JobSkill,
  JobStatus,
  QuestionType,
} from './entities';
import {
  CreateJobDto,
  ExtractedJobInfo,
  ExtractJobInfoDto,
  GeneratedQuestion,
  GenerateQuestionsDto,
  ListJobsQueryDto,
  UpdateJobDto,
} from './dto';

/** Kept in sync with the frontend's `DEPARTMENTS` list
 * (better_screening-FE/src/lib/validation/job.schemas.ts) — duplicated rather than
 * shared since FE/BE are separate deployables with no shared package here. Used to
 * constrain the AI job-extraction feature's "best guess" department to a value the
 * Create Job form's dropdown actually offers. */
const DEPARTMENTS = ['Engineering', 'Product', 'Design', 'Marketing', 'Sales', 'People'];

/** A job as shown in the jobs list — the base entity plus real, computed
 * applicant-pipeline info so the UI can render counts/avatars without lying. */
export interface JobListItem extends Job {
  applicantsCount: number;
  recentApplicants: { id: string; name: string }[];
}

@Injectable()
export class JobsService {
  constructor(
    @InjectRepository(Job)
    private readonly jobsRepository: Repository<Job>,
    @InjectRepository(JobSkill)
    private readonly jobSkillsRepository: Repository<JobSkill>,
    @InjectRepository(InterviewRoundTemplate)
    private readonly roundTemplatesRepository: Repository<InterviewRoundTemplate>,
    @InjectRepository(Candidate)
    private readonly candidatesRepository: Repository<Candidate>,
    @InjectRepository(OrganizationSettings)
    private readonly orgSettingsRepository: Repository<OrganizationSettings>,
    private readonly llmService: LlmService,
    private readonly activityService: ActivityService,
  ) {}

  async create(organizationId: string, createdByUserId: string, dto: CreateJobDto): Promise<Job> {
    const job = this.jobsRepository.create({
      organizationId,
      createdByUserId,
      title: dto.title,
      department: dto.department,
      location: dto.location,
      employmentType: dto.employmentType ?? EmploymentType.FULL_TIME,
      experienceMin: dto.experienceMin,
      experienceMax: dto.experienceMax,
      salaryMin: dto.salaryMin,
      salaryMax: dto.salaryMax,
      salaryCurrency: dto.salaryCurrency ?? 'INR',
      positionsCount: dto.positionsCount ?? 1,
      status: dto.status ?? JobStatus.DRAFT,
      description: dto.description,
      skills: (dto.skills ?? []).map((s, i) =>
        this.jobSkillsRepository.create({ ...s, orderIndex: s.orderIndex ?? i }),
      ),
      rounds: (dto.rounds ?? []).map((r, i) =>
        this.roundTemplatesRepository.create({
          ...r,
          organizationId,
          orderIndex: r.orderIndex ?? i,
          questions: (r.questions ?? []).map((q, qi) => ({ ...q, orderIndex: q.orderIndex ?? qi })),
        }),
      ),
    });
    const saved = await this.jobsRepository.save(job);
    await this.activityService.log({
      organizationId,
      type: ActivityType.JOB_CREATED,
      message: `New job posted: ${saved.title}`,
      actorUserId: createdByUserId,
    });
    return this.findOne(organizationId, saved.id);
  }

  async findAll(organizationId: string, query: ListJobsQueryDto): Promise<JobListItem[]> {
    const qb = this.jobsRepository
      .createQueryBuilder('job')
      .leftJoinAndSelect('job.skills', 'skills')
      .leftJoinAndSelect('job.rounds', 'rounds')
      .where('job.organizationId = :organizationId', { organizationId })
      .orderBy('job.createdAt', 'DESC');

    if (query.status) qb.andWhere('job.status = :status', { status: query.status });
    if (query.department) {
      qb.andWhere('job.department = :department', { department: query.department });
    }
    if (query.search) {
      qb.andWhere('(job.title ILIKE :search OR job.department ILIKE :search)', {
        search: `%${query.search}%`,
      });
    }

    const jobs = await qb.getMany();
    return this.withApplicantInfo(jobs);
  }

  /** Attaches a real applicant count + up to 3 most-recent applicants per job, via
   * two grouped queries (not one-per-job) so the jobs list stays cheap regardless
   * of how many jobs/candidates an org has. */
  private async withApplicantInfo(jobs: Job[]): Promise<JobListItem[]> {
    if (jobs.length === 0) return [];
    const jobIds = jobs.map((j) => j.id);

    const counts = await this.candidatesRepository
      .createQueryBuilder('candidate')
      .select('candidate.jobId', 'jobId')
      .addSelect('COUNT(*)', 'count')
      .where('candidate.jobId IN (:...jobIds)', { jobIds })
      .groupBy('candidate.jobId')
      .getRawMany<{ jobId: string; count: string }>();
    const countByJob = new Map(counts.map((c) => [c.jobId, Number(c.count)]));

    const candidates = await this.candidatesRepository.find({
      where: { jobId: In(jobIds) },
      select: { id: true, jobId: true, name: true, createdAt: true },
      order: { createdAt: 'DESC' },
    });
    const recentByJob = new Map<string, { id: string; name: string }[]>();
    for (const c of candidates) {
      const list = recentByJob.get(c.jobId) ?? [];
      if (list.length < 3) list.push({ id: c.id, name: c.name });
      recentByJob.set(c.jobId, list);
    }

    return jobs.map((job) => ({
      ...job,
      applicantsCount: countByJob.get(job.id) ?? 0,
      recentApplicants: recentByJob.get(job.id) ?? [],
    }));
  }

  async findOne(organizationId: string, id: string): Promise<Job> {
    const job = await this.jobsRepository.findOne({
      where: { id, organizationId },
      relations: { skills: true, rounds: { questions: true }, createdBy: true },
      order: {
        skills: { orderIndex: 'ASC' },
        rounds: { orderIndex: 'ASC', questions: { orderIndex: 'ASC' } },
      },
    });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  async update(organizationId: string, id: string, dto: UpdateJobDto): Promise<Job> {
    await this.findOne(organizationId, id); // 404s if missing/wrong org

    const { skills, rounds, ...scalarFields } = dto;
    if (Object.keys(scalarFields).length > 0) {
      await this.jobsRepository.update({ id, organizationId }, scalarFields);
    }

    if (skills) {
      await this.jobSkillsRepository.delete({ jobId: id });
      await this.jobSkillsRepository.save(
        skills.map((s, i) =>
          this.jobSkillsRepository.create({ ...s, jobId: id, orderIndex: s.orderIndex ?? i }),
        ),
      );
    }

    if (rounds) {
      await this.roundTemplatesRepository.delete({ jobId: id });
      await this.roundTemplatesRepository.save(
        rounds.map((r, i) =>
          this.roundTemplatesRepository.create({
            ...r,
            jobId: id,
            organizationId,
            orderIndex: r.orderIndex ?? i,
            questions: (r.questions ?? []).map((q, qi) => ({
              ...q,
              orderIndex: q.orderIndex ?? qi,
            })),
          }),
        ),
      );
    }

    return this.findOne(organizationId, id);
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const result = await this.jobsRepository.delete({ id, organizationId });
    if (result.affected === 0) throw new NotFoundException('Job not found');
  }

  /** Suggests questions for an existing round — a pure LLM call, nothing persisted.
   * The recruiter edits/reorders/drops suggestions client-side, then saves the round
   * (with whichever questions they kept) via the normal `update()` endpoint. */
  async generateQuestions(
    organizationId: string,
    jobId: string,
    roundId: string,
    dto: GenerateQuestionsDto,
  ): Promise<GeneratedQuestion[]> {
    const settings = await this.orgSettingsRepository.findOne({ where: { organizationId } });
    if (settings && !settings.aiQuestionGenEnabled) {
      throw new BadRequestException(
        'AI question generation is turned off for your organization. An admin can re-enable it in Settings → AI settings, or add questions manually.',
      );
    }

    const job = await this.findOne(organizationId, jobId);
    const round = (job.rounds ?? []).find((r) => r.id === roundId);
    if (!round) throw new NotFoundException('Interview round not found on this job');

    const count = dto.count ?? 5;
    const skillsList =
      (job.skills ?? [])
        .map((s) => `- ${s.name} (${s.level}, ${s.importance} priority)`)
        .join('\n') || '(none listed)';
    const existingQuestions =
      (round.questions ?? []).map((q) => `- ${q.questionText}`).join('\n') || '(none yet)';

    const system = `You are an expert technical interviewer. Given a job's details and an interview round's type, suggest new interview questions for that round. Respond with ONLY a JSON object (no markdown fences, no commentary) matching exactly this shape:
{ "questions": [ { "questionText": <string>, "questionType": "technical" | "behavioral" | "situational" | "experience" | "culture" }, ... exactly ${count} entries ] }`;

    const prompt = `## Job
Title: ${job.title}
Department: ${job.department}
Description: ${job.description || '(none provided)'}
Required skills:
${skillsList}

## Round
Name: ${round.name}
Type: ${round.type}
Duration: ${round.durationMinutes} minutes

## Already-asked questions in this round (don't repeat these)
${existingQuestions}
${dto.additionalContext ? `\n## Recruiter's guidance\n${dto.additionalContext}` : ''}

Suggest ${count} new, non-redundant questions appropriate for a "${round.type}" round.`;

    const result = await this.llmService.completeJson<{ questions: GeneratedQuestion[] }>(
      { system, prompt },
      () => ({
        questions: Array.from({ length: count }, (_, i) => ({
          questionText: `[mock] Sample ${round.type} question #${i + 1} for a ${job.title} candidate.`,
          questionType:
            round.type === InterviewRoundType.HR ? QuestionType.CULTURE : QuestionType.TECHNICAL,
        })),
      }),
    );
    return result.questions;
  }

  /** Extracts structured job fields from arbitrary pasted text (a LinkedIn post, a
   * plain job description, informal notes, etc.) — a pure LLM call, nothing
   * persisted. The recruiter reviews/edits the pre-filled Create Job form before
   * submitting the normal `create()` endpoint. */
  async extractJobInfo(dto: ExtractJobInfoDto): Promise<ExtractedJobInfo> {
    const system = `You are an expert technical recruiter. Extract structured job posting information from arbitrary pasted text (which may be a LinkedIn job post, a plain job description, or informal notes). Respond with ONLY a JSON object (no markdown fences, no commentary) matching exactly this shape:
{ "title": <string|null>, "department": <string|null, your best guess among exactly these values: ${DEPARTMENTS.join(', ')} — pick the closest match, never invent a new one>, "location": <string|null>, "employmentType": <"full_time"|"part_time"|"contract"|"internship"|null>, "experienceMin": <number|null, years>, "experienceMax": <number|null, years>, "positionsCount": <number|null>, "description": <string|null, a cleaned-up 2-4 paragraph role description derived from the text>, "skills": <string[], notable required/desired skills mentioned, deduplicated, max 20> }
Use null for anything you cannot confidently determine — never invent data not implied by the text.`;
    const prompt = `Pasted job post/description:\n\n${dto.pastedText}`;

    const result = await this.llmService.completeJson<Record<string, unknown>>(
      { system, prompt },
      () => ({
        title: '[mock] Senior Frontend Developer',
        department: 'Engineering',
        location: 'Bengaluru, India',
        employmentType: 'full_time',
        experienceMin: 3,
        experienceMax: 6,
        positionsCount: 1,
        description:
          '[mock] Deterministic canned job description generated by LLM_PROVIDER=mock for local development/testing.',
        skills: ['React', 'TypeScript', 'REST APIs'],
      }),
    );
    return this.normalizeExtractedJobInfo(result);
  }

  /** Validates/coerces the raw LLM output and drops anything invalid or missing —
   * the frontend only overwrites form fields present in the response, leaving the
   * rest exactly as the recruiter left them. */
  private normalizeExtractedJobInfo(raw: Record<string, unknown>): ExtractedJobInfo {
    const clean: ExtractedJobInfo = {};
    if (typeof raw.title === 'string' && raw.title.trim()) clean.title = raw.title;
    if (typeof raw.department === 'string' && DEPARTMENTS.includes(raw.department)) {
      clean.department = raw.department;
    }
    if (typeof raw.location === 'string' && raw.location.trim()) clean.location = raw.location;
    if (
      typeof raw.employmentType === 'string' &&
      Object.values(EmploymentType).includes(raw.employmentType as EmploymentType)
    ) {
      clean.employmentType = raw.employmentType as EmploymentType;
    }
    if (typeof raw.experienceMin === 'number' && raw.experienceMin >= 0) {
      clean.experienceMin = Math.round(raw.experienceMin);
    }
    if (typeof raw.experienceMax === 'number' && raw.experienceMax >= 0) {
      clean.experienceMax = Math.round(raw.experienceMax);
    }
    if (typeof raw.positionsCount === 'number' && raw.positionsCount >= 1) {
      clean.positionsCount = Math.round(raw.positionsCount);
    }
    if (typeof raw.description === 'string' && raw.description.trim()) {
      clean.description = raw.description;
    }
    if (Array.isArray(raw.skills)) {
      const skills = raw.skills
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((name) => ({ name }));
      if (skills.length > 0) clean.skills = skills;
    }
    return clean;
  }
}
