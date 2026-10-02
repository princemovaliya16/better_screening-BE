import { InterviewStatus } from '@module/interviews/entities';
import { EvaluationRecommendation, InterviewQuestionAnalysis, InterviewSummary } from './entities';
import { EvaluationService } from './evaluation.service';
import { EvaluationLlmResult } from './types/evaluation-llm-result.type';

const INTERVIEW_ID = 'interview-1';

const interview = {
  id: INTERVIEW_ID,
  organizationId: 'org-1',
  candidateId: 'cand-1',
  status: InterviewStatus.PENDING_EVALUATION,
  roundName: 'AI Screening',
  createdByUserId: null,
  candidate: { name: 'Alex', resumeText: 'Node developer', skills: [] },
  job: { title: 'Backend Engineer', description: 'Build APIs', skills: [] },
  questions: [
    { id: 'q1', questionText: 'What is React?', orderIndex: 0 },
    { id: 'q2', questionText: 'Why hire you?', orderIndex: 1 },
  ],
};

function llmResult(overrides: Partial<EvaluationLlmResult> = {}): EvaluationLlmResult {
  const s = (score: number) => ({ score, reason: 'because' });
  return {
    scores: {
      knowledge: s(80),
      communication: s(70),
      relevance: s(90),
      jobFit: s(60),
      problemSolving: s(75),
      confidence: s(65),
    },
    recommendation: 'hire',
    strengths: ['clear'],
    weaknesses: ['shallow'],
    observations: 'ok',
    communicationNote: 'fine',
    perQuestion: [
      { questionId: 'q1', knowledge: 80, communication: 70, relevance: 90, feedback: 'good' },
      { questionId: 'q2', knowledge: 50, communication: 60, relevance: 70, feedback: 'fair' },
    ],
    ...overrides,
  };
}

function setup(transcripts: Record<string, string>, llm?: EvaluationLlmResult) {
  const saved: {
    summary?: Partial<InterviewSummary>;
    analyses?: Partial<InterviewQuestionAnalysis>[];
  } = {};
  const manager = {
    create: (_entity: unknown, data: object) => data,
    save: jest.fn((data: unknown) => {
      if (Array.isArray(data)) saved.analyses = data as Partial<InterviewQuestionAnalysis>[];
      else saved.summary = data as Partial<InterviewSummary>;
      return Promise.resolve(data);
    }),
    update: jest.fn(() => Promise.resolve()),
  };
  const llmService = { completeJson: jest.fn(() => Promise.resolve(llm ?? llmResult())) };
  const service = new EvaluationService(
    { findOne: jest.fn(() => Promise.resolve(interview)) } as never,
    {
      findOne: jest.fn(() =>
        Promise.resolve({
          interviewId: INTERVIEW_ID,
          perQuestion: Object.entries(transcripts).map(([questionId, transcriptText]) => ({
            questionId,
            transcriptText,
          })),
        }),
      ),
    } as never,
    {
      find: jest.fn(() =>
        Promise.resolve(
          Object.entries(transcripts).map(([questionId, text]) => ({
            interviewQuestionId: questionId,
            transcriptText: text,
            transcriptSegments: text ? [{ start: 1, end: 11, text }] : [],
            recordingDurationSeconds: 12,
          })),
        ),
      ),
    } as never,
    { findOne: jest.fn(() => Promise.resolve(null)) } as never,
    { find: jest.fn() } as never,
    { findOne: jest.fn() } as never,
    { transaction: (fn: (m: typeof manager) => Promise<void>) => fn(manager) } as never,
    llmService as never,
    { log: jest.fn() } as never,
    { create: jest.fn() } as never,
  );
  return { service, saved, llmService, manager };
}

describe('EvaluationService.evaluate', () => {
  it('stores six independent scores with reasons, and the overall as their average', async () => {
    const t = setup({ q1: 'React is a UI library', q2: 'I ship reliable software' });

    await t.service.evaluate(INTERVIEW_ID);

    expect(t.saved.summary?.competencyScores).toEqual({
      knowledge: 80,
      communication: 70,
      relevance: 90,
      jobFit: 60,
      problemSolving: 75,
      confidence: 65,
    });
    expect(t.saved.summary?.scoreReasons?.knowledge).toBe('because');
    expect(t.saved.summary?.overallScore).toBe(73); // (80+70+90+60+75+65)/6 = 73.3
    expect(t.saved.summary?.speechMetrics?.perQuestion.q1.wordCount).toBe(5);
    expect(t.saved.analyses?.[0]).toMatchObject({
      interviewQuestionId: 'q1',
      dimensionScores: { knowledge: 80, communication: 70, relevance: 90 },
      score: 80,
    });
    expect(t.manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: INTERVIEW_ID },
      { status: InterviewStatus.COMPLETED, overallScore: 73 },
    );
  });

  it('forces an unanswered question to 0 whatever the model returned', async () => {
    const t = setup({ q1: 'React is a UI library', q2: '' });

    await t.service.evaluate(INTERVIEW_ID);

    expect(t.saved.analyses?.[1]).toMatchObject({
      interviewQuestionId: 'q2',
      score: 0,
      dimensionScores: { knowledge: 0, communication: 0, relevance: 0 },
    });
    expect(t.saved.analyses?.[1].feedback).toMatch(/No answer was given/);
  });

  it('skips the LLM entirely when no answer has any speech', async () => {
    const t = setup({ q1: '', q2: '   ' });

    await t.service.evaluate(INTERVIEW_ID);

    expect(t.llmService.completeJson).not.toHaveBeenCalled();
    expect(t.saved.summary?.overallScore).toBe(0);
    expect(t.saved.summary?.recommendation).toBe(EvaluationRecommendation.STRONG_NO_HIRE);
    expect(Object.values(t.saved.summary?.competencyScores ?? {})).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('rejects (so BullMQ retries) a response with a missing or out-of-range category', async () => {
    const bad = llmResult();
    delete (bad.scores as Partial<typeof bad.scores>).confidence;
    await expect(setup({ q1: 'a', q2: 'b' }, bad).service.evaluate(INTERVIEW_ID)).rejects.toThrow(
      /scores\.confidence/,
    );

    const outOfRange = llmResult();
    outOfRange.scores.knowledge.score = 140;
    await expect(
      setup({ q1: 'a', q2: 'b' }, outOfRange).service.evaluate(INTERVIEW_ID),
    ).rejects.toThrow(/scores\.knowledge/);
  });

  it('rejects a response missing an answered question, and drops unknown ids', async () => {
    const missing = llmResult({ perQuestion: [llmResult().perQuestion[0]] });
    await expect(
      setup({ q1: 'a', q2: 'b' }, missing).service.evaluate(INTERVIEW_ID),
    ).rejects.toThrow(/missing an entry for question q2/);

    const extra = llmResult({
      perQuestion: [
        ...llmResult().perQuestion,
        { questionId: 'ghost', knowledge: 1, communication: 1, relevance: 1, feedback: 'x' },
      ],
    });
    const t = setup({ q1: 'a', q2: 'b' }, extra);
    await t.service.evaluate(INTERVIEW_ID);
    expect(t.saved.analyses?.map((a) => a.interviewQuestionId)).toEqual(['q1', 'q2']);
  });
});
