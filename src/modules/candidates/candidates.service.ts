import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ActivityService, ActivityType } from '@module/activity';
import { Job } from '@module/jobs/entities';
import { LlmService } from '@core/llm';
import {
  CandidateNote,
  CandidateSkill,
  Candidate,
  CandidateStage,
  CANDIDATE_STAGE_RANK,
} from './entities';
import {
  CreateCandidateDto,
  CreateNoteDto,
  ListCandidatesQueryDto,
  ParsedResumeInfo,
  UpdateCandidateDto,
} from './dto';

@Injectable()
export class CandidatesService {
  constructor(
    @InjectRepository(Candidate)
    private readonly candidatesRepository: Repository<Candidate>,
    @InjectRepository(CandidateSkill)
    private readonly candidateSkillsRepository: Repository<CandidateSkill>,
    @InjectRepository(CandidateNote)
    private readonly candidateNotesRepository: Repository<CandidateNote>,
    @InjectRepository(Job)
    private readonly jobsRepository: Repository<Job>,
    private readonly activityService: ActivityService,
    private readonly llmService: LlmService,
  ) {}

  private async assertJobInOrg(organizationId: string, jobId: string): Promise<void> {
    const job = await this.jobsRepository.findOne({ where: { id: jobId, organizationId } });
    if (!job) throw new BadRequestException('That job does not exist in your organization');
  }

  async create(organizationId: string, dto: CreateCandidateDto): Promise<Candidate> {
    await this.assertJobInOrg(organizationId, dto.jobId);

    const candidate = this.candidatesRepository.create({
      organizationId,
      jobId: dto.jobId,
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      experienceYears: dto.experienceYears,
      currentCompany: dto.currentCompany,
      location: dto.location,
      education: dto.education,
      resumeSummary: dto.resumeSummary,
      skills: (dto.skills ?? []).map((name) => this.candidateSkillsRepository.create({ name })),
    });
    const saved = await this.candidatesRepository.save(candidate);
    await this.activityService.log({
      organizationId,
      type: ActivityType.CANDIDATE_CREATED,
      message: `${saved.name} added as a candidate`,
    });
    return this.findOne(organizationId, saved.id);
  }

  async findAll(organizationId: string, query: ListCandidatesQueryDto): Promise<Candidate[]> {
    const qb = this.candidatesRepository
      .createQueryBuilder('candidate')
      .leftJoinAndSelect('candidate.skills', 'skills')
      .leftJoinAndSelect('candidate.job', 'job')
      .where('candidate.organizationId = :organizationId', { organizationId })
      .orderBy('candidate.createdAt', 'DESC');

    if (query.jobId) qb.andWhere('candidate.jobId = :jobId', { jobId: query.jobId });
    if (query.stage) qb.andWhere('candidate.stage = :stage', { stage: query.stage });
    if (query.search) {
      qb.andWhere('(candidate.name ILIKE :search OR candidate.email ILIKE :search)', {
        search: `%${query.search}%`,
      });
    }

    return qb.getMany();
  }

  async findOne(organizationId: string, id: string): Promise<Candidate> {
    const candidate = await this.candidatesRepository.findOne({
      where: { id, organizationId },
      // job.rounds is loaded here (not just the job's own fields) because the
      // "schedule interview" flow on the candidate details page needs the job's
      // round templates to populate its round picker.
      relations: { skills: true, job: { rounds: { questions: true } }, notes: { author: true } },
      order: {
        notes: { createdAt: 'DESC' },
        job: { rounds: { orderIndex: 'ASC', questions: { orderIndex: 'ASC' } } },
      },
    });
    if (!candidate) throw new NotFoundException('Candidate not found');
    return candidate;
  }

  async update(organizationId: string, id: string, dto: UpdateCandidateDto): Promise<Candidate> {
    await this.findOne(organizationId, id);
    if (dto.jobId) await this.assertJobInOrg(organizationId, dto.jobId);

    const { skills, ...scalarFields } = dto;
    if (Object.keys(scalarFields).length > 0) {
      await this.candidatesRepository.update({ id, organizationId }, scalarFields);
    }
    if (skills) {
      await this.candidateSkillsRepository.delete({ candidateId: id });
      await this.candidateSkillsRepository.save(
        skills.map((name) => this.candidateSkillsRepository.create({ candidateId: id, name })),
      );
    }
    return this.findOne(organizationId, id);
  }

  async updateStage(
    organizationId: string,
    id: string,
    stage: CandidateStage,
    rejectReason?: string,
  ): Promise<Candidate> {
    const candidate = await this.findOne(organizationId, id);

    if (stage !== CandidateStage.REJECTED) {
      const currentRank = CANDIDATE_STAGE_RANK[candidate.stage];
      const targetRank = CANDIDATE_STAGE_RANK[stage];
      if (targetRank < currentRank) {
        throw new BadRequestException(
          `Cannot move a candidate backward from "${candidate.stage}" to "${stage}"`,
        );
      }
    }

    await this.candidatesRepository.update(
      { id, organizationId },
      { stage, rejectReason: stage === CandidateStage.REJECTED ? (rejectReason ?? null) : null },
    );
    await this.activityService.log({
      organizationId,
      type: ActivityType.CANDIDATE_STAGE_CHANGED,
      message: `${candidate.name} moved to ${stage.replace('_', ' ')}`,
    });
    return this.findOne(organizationId, id);
  }

  /** Internal, system-driven forward-only stage bump — used by InterviewsModule when
   * scheduling a round moves the candidate further along than a manual reject/hire
   * decision. Never throws, never moves backward, never touches REJECTED candidates. */
  async advanceStageIfForward(
    organizationId: string,
    id: string,
    targetStage: CandidateStage,
  ): Promise<void> {
    const candidate = await this.candidatesRepository.findOne({ where: { id, organizationId } });
    if (!candidate || candidate.stage === CandidateStage.REJECTED) return;
    if (CANDIDATE_STAGE_RANK[targetStage] > CANDIDATE_STAGE_RANK[candidate.stage]) {
      await this.candidatesRepository.update({ id, organizationId }, { stage: targetStage });
    }
  }

  async addNote(
    organizationId: string,
    candidateId: string,
    authorUserId: string,
    dto: CreateNoteDto,
  ): Promise<CandidateNote> {
    await this.findOne(organizationId, candidateId); // 404s if missing/wrong org
    const note = this.candidateNotesRepository.create({
      organizationId,
      candidateId,
      authorUserId,
      body: dto.body,
    });
    return this.candidateNotesRepository.save(note);
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const result = await this.candidatesRepository.delete({ id, organizationId });
    if (result.affected === 0) throw new NotFoundException('Candidate not found');
  }

  /** Extracts structured fields from an uploaded resume for the Add Candidate form
   * to pre-fill — a pure LLM call, nothing persisted (the file itself is never
   * stored). The recruiter reviews/edits the pre-filled fields before the normal
   * `create()` submission. Mirrors `EmailComposerService.compose()`'s extraction
   * style. */
  async parseResume(file: Express.Multer.File): Promise<ParsedResumeInfo> {
    const text = await this.extractResumeText(file);
    if (!text.trim()) {
      throw new BadRequestException('Could not extract any text from that file');
    }

    const system = `You are an expert technical recruiter. Extract structured candidate information from a resume's plain text. Respond with ONLY a JSON object (no markdown fences, no commentary) matching exactly this shape:
{ "name": <string|null>, "email": <string|null>, "phone": <string|null>, "experienceYears": <number|null, total years of professional experience, your best estimate>, "currentCompany": <string|null, most recent employer>, "location": <string|null, city/country>, "education": <string|null, highest/most relevant qualification, e.g. "B.Tech, IIT Bombay">, "skills": <string[], notable technical/professional skills, deduplicated, max 20> }
Use null for any field you cannot confidently determine from the text — never invent data.`;
    const prompt = `Resume text:\n\n${text.slice(0, 15000)}`;

    const result = await this.llmService.completeJson<ParsedResumeInfo>({ system, prompt }, () => ({
      name: '[mock] Jane Doe',
      email: 'jane.doe@example.com',
      phone: '+91 9876543210',
      experienceYears: 5,
      currentCompany: '[mock] Acme Corp',
      location: 'Bengaluru, India',
      education: 'B.Tech, IIT Bombay',
      skills: ['React', 'TypeScript', 'Node.js'],
    }));
    return this.normalizeParsedResume(result);
  }

  /** Drops null/invalid/empty fields so the frontend only overwrites form fields the
   * model confidently extracted, leaving everything else as the recruiter left it. */
  private normalizeParsedResume(raw: ParsedResumeInfo): ParsedResumeInfo {
    const clean: ParsedResumeInfo = {};
    if (raw.name) clean.name = raw.name;
    if (raw.email) clean.email = raw.email;
    if (raw.phone) clean.phone = raw.phone;
    if (typeof raw.experienceYears === 'number' && raw.experienceYears >= 0) {
      clean.experienceYears = Math.round(raw.experienceYears);
    }
    if (raw.currentCompany) clean.currentCompany = raw.currentCompany;
    if (raw.location) clean.location = raw.location;
    if (raw.education) clean.education = raw.education;
    if (Array.isArray(raw.skills) && raw.skills.length > 0) {
      const skills = raw.skills.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
      if (skills.length > 0) clean.skills = skills;
    }
    return clean;
  }

  private async extractResumeText(file: Express.Multer.File): Promise<string> {
    if (file.mimetype === 'application/pdf') {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: file.buffer });
      try {
        const { text } = await parser.getText();
        return text;
      } finally {
        await parser.destroy();
      }
    }
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer: file.buffer });
    return value;
  }
}
