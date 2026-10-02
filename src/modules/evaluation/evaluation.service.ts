import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { LlmService } from '@core/llm';
import { ActivityService, ActivityType } from '@module/activity';
import { Candidate } from '@module/candidates/entities';
import { InterviewAnswer } from '@module/interview-session/entities';
import { Interview, InterviewStatus } from '@module/interviews/entities';
import { NotificationsService, NotificationType } from '@module/notifications';
import { OrganizationSettings } from '@module/organizations/entities';
import { InterviewTranscript } from '@module/transcript-ingestion/entities';
import {
  EvaluationRecommendation,
  InterviewQuestionAnalysis,
  InterviewSummary,
  QuestionDimensionScores,
  SCORE_DIMENSIONS,
  ScoreDimension,
} from './entities';
import {
  SpeechMetrics,
  SpeechMetricsValues,
  computeSpeechMetrics,
  countWords,
} from './speech-metrics';
import { EvaluationLlmResult } from './types/evaluation-llm-result.type';

const RECOMMENDATION_VALUES = new Set(Object.values(EvaluationRecommendation));
const QUESTION_DIMENSIONS = ['knowledge', 'communication', 'relevance'] as const;
/** Keeps the prompt (and cost) bounded for very long resumes. */
const MAX_RESUME_CHARS = 20_000;
const NO_ANSWER_FEEDBACK = 'No answer was given — no speech was detected in the recording.';

interface PromptQuestion {
  questionId: string;
  questionText: string;
  transcriptText: string;
  hasSpeech: boolean;
  speech: SpeechMetricsValues | undefined;
}

/** The validated, normalised analysis that gets persisted. */
export interface NormalisedEvaluation {
  overallScore: number;
  recommendation: EvaluationRecommendation;
  scores: Record<ScoreDimension, number>;
  reasons: Record<ScoreDimension, string>;
  strengths: string[];
  weaknesses: string[];
  observations: string;
  communicationNote: string;
  perQuestion: {
    questionId: string;
    score: number;
    dimensionScores: QuestionDimensionScores;
    feedback: string;
  }[];
}

export type EvaluationStatus =
  'not_submitted' | 'transcribing' | 'transcription_failed' | 'evaluating' | 'completed';

export interface EvaluationView {
  status: EvaluationStatus;
  summary?: InterviewSummary;
  questionAnalyses?: InterviewQuestionAnalysis[];
}

const clampScore = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const average = (values: number[]) =>
  values.length ? clampScore(values.reduce((sum, v) => sum + v, 0) / values.length) : 0;

/**
 * Owns the AI interview analysis — resume × job description × transcript (plus
 * measured speech delivery). Six categories are each scored 0–100 independently; the
 * overall score is their average, computed here so it always matches them. This is
 * entirely our own LLM call, never the transcription service's. Consumed by
 * `EvaluationProcessingProcessor` off the internal `evaluation-processing` queue, and
 * re-triggerable via `InterviewsService.retryEvaluation`.
 */
@Injectable()
export class EvaluationService {
  private readonly logger = new Logger(EvaluationService.name);

  constructor(
    @InjectRepository(Interview)
    private readonly interviewsRepository: Repository<Interview>,
    @InjectRepository(InterviewTranscript)
    private readonly transcriptsRepository: Repository<InterviewTranscript>,
    @InjectRepository(InterviewAnswer)
    private readonly answersRepository: Repository<InterviewAnswer>,
    @InjectRepository(InterviewSummary)
    private readonly summariesRepository: Repository<InterviewSummary>,
    @InjectRepository(InterviewQuestionAnalysis)
    private readonly analysesRepository: Repository<InterviewQuestionAnalysis>,
    @InjectRepository(OrganizationSettings)
    private readonly organizationSettingsRepository: Repository<OrganizationSettings>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly llmService: LlmService,
    private readonly activityService: ActivityService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async evaluate(interviewId: string): Promise<void> {
    const existing = await this.summariesRepository.findOne({ where: { interviewId } });
    if (existing) {
      this.logger.log(
        `Evaluation for interview ${interviewId} already exists — skipping (idempotent)`,
      );
      return;
    }

    const interview = await this.interviewsRepository.findOne({
      where: { id: interviewId },
      relations: { candidate: { skills: true }, job: { skills: true }, questions: true },
      order: { questions: { orderIndex: 'ASC' } },
    });
    if (!interview) {
      this.logger.error(`evaluate: interview ${interviewId} not found — skipping (not retryable)`);
      return;
    }

    const transcript = await this.transcriptsRepository.findOne({ where: { interviewId } });
    if (!transcript || transcript.failureReason) {
      this.logger.error(
        `evaluate: interview ${interviewId} has no usable transcript yet — skipping ` +
          `(re-run once transcription succeeds, e.g. via retry-evaluation)`,
      );
      return;
    }

    const answers = await this.answersRepository.find({ where: { interviewId } });
    const answerByQuestionId = new Map(answers.map((a) => [a.interviewQuestionId, a]));
    const transcriptByQuestionId = new Map(
      transcript.perQuestion.map((p) => [p.questionId, p.transcriptText]),
    );

    const speechMetrics: SpeechMetrics = computeSpeechMetrics(
      (interview.questions ?? []).map((q) => {
        const answer = answerByQuestionId.get(q.id);
        return {
          questionId: q.id,
          transcriptText: transcriptByQuestionId.get(q.id) ?? answer?.transcriptText,
          segments: answer?.transcriptSegments,
          recordingSeconds: answer?.recordingDurationSeconds,
        };
      }),
    );

    const questions: PromptQuestion[] = (interview.questions ?? []).map((q) => {
      const text = (
        transcriptByQuestionId.get(q.id) ??
        answerByQuestionId.get(q.id)?.transcriptText ??
        ''
      ).trim();
      return {
        questionId: q.id,
        questionText: q.questionText,
        transcriptText: text,
        hasSpeech: countWords(text) > 0,
        speech: speechMetrics.perQuestion[q.id],
      };
    });

    let evaluation: NormalisedEvaluation;
    let rawLlmResponse: unknown;
    if (!questions.some((q) => q.hasSpeech)) {
      // Nothing was said — don't ask a model to invent an assessment.
      this.logger.warn(`evaluate: interview ${interviewId} has no speech in any answer`);
      evaluation = this.noSpeechEvaluation(questions);
      rawLlmResponse = { skipped: 'no speech detected in any answer' };
    } else {
      const { system, prompt } = this.buildPrompt(interview, questions, speechMetrics);
      const result = await this.llmService.completeJson<EvaluationLlmResult>(
        { system, prompt, maxTokens: 4096 },
        () => this.mockResult(questions),
      );
      evaluation = this.normalise(result, questions);
      rawLlmResponse = result;
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.save(
        manager.create(InterviewSummary, {
          organizationId: interview.organizationId,
          interviewId: interview.id,
          overallScore: evaluation.overallScore,
          recommendation: evaluation.recommendation,
          strengths: evaluation.strengths,
          weaknesses: evaluation.weaknesses,
          observations: evaluation.observations,
          communicationNote: evaluation.communicationNote,
          competencyScores: evaluation.scores,
          scoreReasons: evaluation.reasons,
          speechMetrics,
          rawLlmResponse,
        }),
      );
      await manager.save(
        evaluation.perQuestion.map((pq) =>
          manager.create(InterviewQuestionAnalysis, {
            organizationId: interview.organizationId,
            interviewId: interview.id,
            interviewQuestionId: pq.questionId,
            score: pq.score,
            dimensionScores: pq.dimensionScores,
            feedback: pq.feedback,
          }),
        ),
      );
      await manager.update(
        Interview,
        { id: interview.id },
        { status: InterviewStatus.COMPLETED, overallScore: evaluation.overallScore },
      );
      await manager.update(
        Candidate,
        { id: interview.candidateId, organizationId: interview.organizationId },
        { overallScore: evaluation.overallScore },
      );
    });

    this.logger.log(
      `Persisted evaluation for interview ${interview.id} (overall ${evaluation.overallScore})`,
    );

    await this.activityService.log({
      organizationId: interview.organizationId,
      type: ActivityType.EVALUATION_COMPLETED,
      message: `AI evaluation ready for ${interview.candidate?.name ?? 'a candidate'} — ${interview.roundName} (score ${evaluation.overallScore})`,
    });

    if (interview.createdByUserId) {
      const settings = await this.organizationSettingsRepository.findOne({
        where: { organizationId: interview.organizationId },
      });
      if (settings?.notifyOnEvaluationReady !== false) {
        await this.notificationsService.create({
          organizationId: interview.organizationId,
          userId: interview.createdByUserId,
          type: NotificationType.EVALUATION_READY,
          title: 'AI evaluation ready',
          body: `${interview.candidate?.name ?? 'A candidate'}'s ${interview.roundName} scored ${evaluation.overallScore}/100.`,
          link: `/app/interviews/${interview.id}`,
        });
      }
    }
  }

  private describeSpeech(m: SpeechMetricsValues | undefined): string {
    if (!m || m.wordCount === 0) return 'no speech detected';
    const parts = [`${m.wordCount} words`];
    if (m.wordsPerMinute != null) parts.push(`${m.wordsPerMinute} words/min`);
    if (m.talkRatio != null)
      parts.push(`spoke for ${Math.round(m.talkRatio * 100)}% of the recording`);
    parts.push(`${m.longPauses} long pause${m.longPauses === 1 ? '' : 's'} (2s+)`);
    if (m.responseDelaySeconds != null)
      parts.push(`started speaking after ${m.responseDelaySeconds}s`);
    return parts.join(', ');
  }

  private buildPrompt(
    interview: Interview,
    questions: PromptQuestion[],
    speechMetrics: SpeechMetrics,
  ): { system: string; prompt: string } {
    const job = interview.job;
    const candidate = interview.candidate;
    const skillsList =
      (job?.skills ?? [])
        .map(
          (s) =>
            `- ${s.name} (${s.level}, ${s.importance} priority${s.required ? ', required' : ''})`,
        )
        .join('\n') || '(none listed)';
    const experienceRange =
      job?.experienceMin != null || job?.experienceMax != null
        ? `${job?.experienceMin ?? 0}–${job?.experienceMax ?? '+'} years`
        : '(not specified)';
    const resume = candidate?.resumeText?.slice(0, MAX_RESUME_CHARS) || '(no resume text on file)';

    const system = `You are an expert interviewer analysing a recorded, one-way screening interview. You are given the job description and required skills, the candidate's profile and resume, each question with the candidate's transcribed spoken answer, and MEASURED speech-delivery metrics computed from the recording timings. Assess the candidate using ONLY this material — never invent facts that are not in the input.

Score each of these six categories independently from 0 to 100 (they are NOT parts of one total):
- knowledge: correctness and depth of the answers on the subject matter and the job's required skills.
- communication: clarity, structure and fluency of the spoken answers. Use the measured speech metrics as evidence.
- relevance: how directly each answer addresses the question that was asked.
- jobFit: how well the resume and answers match the job description, required skills and experience range.
- problemSolving: quality of reasoning — concrete examples, trade-offs, structured thinking.
- confidence: steadiness and decisiveness of delivery, inferred from the measured metrics and the wording (hedging, hesitation). Do not claim to have seen or heard the candidate.

Rubric: 0 = no evidence at all, 25 = poor, 50 = adequate, 75 = good, 90+ = exceptional. Unanswered or off-topic answers lower the relevant scores. Short or vague answers cannot score high on knowledge or problemSolving.
Speech metrics guidance: about 120–160 words/min is a natural pace; under 100 often reads as hesitant, over 190 as rushed. Speaking for under 50% of the recording, frequent long pauses, or a long delay before starting suggest hesitation. Transcripts are machine-generated, so ignore obvious transcription errors.

Respond with ONLY a JSON object matching exactly this shape:
{
  "scores": {
    "knowledge": { "score": <integer 0-100>, "reason": <one sentence> },
    "communication": { "score": <integer 0-100>, "reason": <one sentence> },
    "relevance": { "score": <integer 0-100>, "reason": <one sentence> },
    "jobFit": { "score": <integer 0-100>, "reason": <one sentence> },
    "problemSolving": { "score": <integer 0-100>, "reason": <one sentence> },
    "confidence": { "score": <integer 0-100>, "reason": <one sentence> }
  },
  "recommendation": "strong_hire" | "hire" | "no_hire" | "strong_no_hire",
  "strengths": [<short string>, ...],
  "weaknesses": [<short string>, ...],
  "observations": <string, 2-4 sentences>,
  "communicationNote": <string, 1-2 sentences on delivery, referring to the measured pace/pauses>,
  "perQuestion": [ { "questionId": <copied exactly from the id given below>, "knowledge": <0-100>, "communication": <0-100>, "relevance": <0-100>, "feedback": <1-2 sentences> }, ... exactly one entry per question below ]
}`;

    const overall = speechMetrics.overall;
    const prompt = `## Job
Title: ${job?.title ?? 'Unknown role'}
Department: ${job?.department ?? ''}
Experience required: ${experienceRange}
Description: ${job?.description || '(none provided)'}
Required skills:
${skillsList}

## Interview round
${interview.roundName}

## Candidate
Name: ${candidate?.name ?? ''}
Experience: ${candidate?.experienceYears != null ? `${candidate.experienceYears} years` : '(unknown)'}
Current company: ${candidate?.currentCompany || '(unknown)'}
Skills listed: ${(candidate?.skills ?? []).map((s) => s.name).join(', ') || '(none listed)'}
Education: ${candidate?.education || '(unknown)'}

## Candidate resume
${resume}

## Measured speech delivery (whole interview)
${this.describeSpeech(overall)}

## Interview questions and transcribed answers
${questions
  .map(
    (q) =>
      `### Question (id: ${q.questionId})\n${q.questionText}\n\nMeasured delivery: ${this.describeSpeech(q.speech)}\nCandidate's answer (transcribed):\n${q.hasSpeech ? q.transcriptText : '(no speech detected — the candidate did not answer)'}`,
  )
  .join('\n\n')}
`;

    return { system, prompt };
  }

  /** Validates the LLM's response and turns it into what we persist. Anything missing
   * or malformed throws, so the BullMQ job retries. Scores are rounded and clamped;
   * unanswered questions are forced to 0 whatever the model said. */
  normalise(result: EvaluationLlmResult, questions: PromptQuestion[]): NormalisedEvaluation {
    const fail = (msg: string): never => {
      throw new Error(`LLM evaluation response failed validation: ${msg}`);
    };
    const isScore = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

    if (!result || typeof result !== 'object') fail('response is not an object');
    if (!RECOMMENDATION_VALUES.has(result.recommendation as EvaluationRecommendation)) {
      fail(`recommendation must be one of ${[...RECOMMENDATION_VALUES].join(', ')}`);
    }
    if (!Array.isArray(result.strengths) || !Array.isArray(result.weaknesses)) {
      fail('strengths/weaknesses must be arrays');
    }
    if (typeof result.observations !== 'string' || typeof result.communicationNote !== 'string') {
      fail('observations/communicationNote must be strings');
    }

    const scores = {} as Record<ScoreDimension, number>;
    const reasons = {} as Record<ScoreDimension, string>;
    for (const key of SCORE_DIMENSIONS) {
      const entry = result.scores?.[key];
      if (!entry || !isScore(entry.score) || entry.score < 0 || entry.score > 100) {
        fail(`scores.${key}.score must be a number between 0 and 100`);
      }
      scores[key] = clampScore(entry.score);
      reasons[key] = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    }

    if (!Array.isArray(result.perQuestion)) fail('perQuestion must be an array');
    const byId = new Map(result.perQuestion.map((p) => [p.questionId, p]));
    const perQuestion = questions.map((q) => {
      if (!q.hasSpeech) return this.noAnswer(q.questionId);
      const pq = byId.get(q.questionId);
      if (!pq) return fail(`perQuestion is missing an entry for question ${q.questionId}`);
      const dimensionScores = {} as QuestionDimensionScores;
      for (const key of QUESTION_DIMENSIONS) {
        if (!isScore(pq[key]) || pq[key] < 0 || pq[key] > 100) {
          fail(`perQuestion.${key} for ${q.questionId} must be a number between 0 and 100`);
        }
        dimensionScores[key] = clampScore(pq[key]);
      }
      if (typeof pq.feedback !== 'string')
        fail(`perQuestion feedback for ${q.questionId} must be a string`);
      return {
        questionId: q.questionId,
        score: average(QUESTION_DIMENSIONS.map((key) => dimensionScores[key])),
        dimensionScores,
        feedback: pq.feedback.trim(),
      };
    });

    return {
      overallScore: average(Object.values(scores)),
      recommendation: result.recommendation as EvaluationRecommendation,
      scores,
      reasons,
      strengths: result.strengths.map(String),
      weaknesses: result.weaknesses.map(String),
      observations: result.observations,
      communicationNote: result.communicationNote,
      perQuestion,
    };
  }

  private noAnswer(questionId: string): NormalisedEvaluation['perQuestion'][number] {
    return {
      questionId,
      score: 0,
      dimensionScores: { knowledge: 0, communication: 0, relevance: 0 },
      feedback: NO_ANSWER_FEEDBACK,
    };
  }

  private noSpeechEvaluation(questions: PromptQuestion[]): NormalisedEvaluation {
    const reason = 'No speech was detected in any answer, so there is nothing to assess.';
    const scores = {} as Record<ScoreDimension, number>;
    const reasons = {} as Record<ScoreDimension, string>;
    for (const key of SCORE_DIMENSIONS) {
      scores[key] = 0;
      reasons[key] = reason;
    }
    return {
      overallScore: 0,
      recommendation: EvaluationRecommendation.STRONG_NO_HIRE,
      scores,
      reasons,
      strengths: [],
      weaknesses: ['No spoken answers were recorded'],
      observations:
        "No speech was detected in this interview — the recordings contain no spoken answers. Consider checking the candidate's microphone and re-inviting them.",
      communicationNote: 'No speech was detected.',
      perQuestion: questions.map((q) => this.noAnswer(q.questionId)),
    };
  }

  private mockResult(questions: { questionId: string }[]): EvaluationLlmResult {
    const s = (score: number, reason: string) => ({ score, reason: `[mock] ${reason}` });
    return {
      scores: {
        knowledge: s(76, 'Covered the core concepts correctly with moderate depth.'),
        communication: s(82, 'Clear, well-paced answers with a logical structure.'),
        relevance: s(85, 'Answers stayed on the questions asked.'),
        jobFit: s(72, 'Experience broadly matches the role, with some gaps in required skills.'),
        problemSolving: s(70, 'Reasoning was sound but light on concrete examples.'),
        confidence: s(78, 'Steady pace with few long pauses.'),
      },
      recommendation: 'hire',
      strengths: ['Clear, structured communicator', 'Solid grasp of core fundamentals'],
      weaknesses: ['Limited depth on large-scale system design'],
      observations:
        '[mock] Deterministic evaluation generated by LLM_PROVIDER=mock for local development/testing — not a real assessment.',
      communicationNote: 'Answered clearly and at a reasonable pace throughout.',
      perQuestion: questions.map((q, i) => ({
        questionId: q.questionId,
        knowledge: 70 + (i % 3) * 5,
        communication: 80,
        relevance: 85 - (i % 2) * 10,
        feedback: '[mock] Reasonable answer that covered the key points.',
      })),
    };
  }

  // ---- Recruiter-facing read model ----

  async getEvaluationView(organizationId: string, interviewId: string): Promise<EvaluationView> {
    const interview = await this.interviewsRepository.findOne({
      where: { id: interviewId, organizationId },
    });
    if (!interview) throw new NotFoundException('Interview not found');

    const summary = await this.summariesRepository.findOne({ where: { interviewId } });
    if (summary) {
      const questionAnalyses = await this.analysesRepository.find({ where: { interviewId } });
      return { status: 'completed', summary, questionAnalyses };
    }

    if (
      interview.status !== InterviewStatus.PENDING_EVALUATION &&
      interview.status !== InterviewStatus.COMPLETED
    ) {
      return { status: 'not_submitted' };
    }

    const transcript = await this.transcriptsRepository.findOne({ where: { interviewId } });
    if (!transcript) return { status: 'transcribing' };
    if (transcript.failureReason) return { status: 'transcription_failed' };
    return { status: 'evaluating' };
  }
}
