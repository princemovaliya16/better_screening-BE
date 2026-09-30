import { Job } from 'bullmq';
import { TranscriptionEventPayload } from '@core/queue';
import {
  AnswerTranscriptionStatus,
  InterviewAnswerStatus,
} from '@module/interview-session/entities';
import { TranscriptAssemblyService } from '../transcript-assembly.service';
import { TranscriptionEventsProcessor } from './transcription-events.processor';

const INTERVIEW_ID = '11111111-1111-4111-8111-111111111111';
const ANSWER_1 = '22222222-2222-4222-8222-222222222222';
const ANSWER_2 = '33333333-3333-4333-8333-333333333333';

interface AnswerRow {
  id: string;
  interviewId: string;
  interviewQuestionId: string;
  transcriptionStatus: AnswerTranscriptionStatus | null;
  transcriptText?: string | null;
  transcriptionError?: string | null;
}

/** In-memory answers table so the processor and the assembly see each other's writes. */
function setup(answers: AnswerRow[]) {
  const rows = new Map(answers.map((a) => [a.id, { ...a }]));
  const answersRepository = {
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(rows.get(where.id) ?? null),
    ),
    find: jest.fn(() =>
      Promise.resolve([...rows.values()].filter((a) => a.transcriptionStatus != null)),
    ),
    update: jest.fn((id: string, fields: Partial<AnswerRow>) => {
      Object.assign(rows.get(id)!, fields);
      return Promise.resolve();
    }),
  };
  const interviewsRepository = {
    findOne: jest.fn(() =>
      Promise.resolve({
        id: INTERVIEW_ID,
        organizationId: 'org-1',
        candidateId: 'cand-1',
        questions: [
          { id: 'q1', orderIndex: 0 },
          { id: 'q2', orderIndex: 1 },
        ],
      }),
    ),
  };
  const transcriptsRepository = {
    findOne: jest.fn(() => Promise.resolve(null)),
    insert: jest.fn<Promise<void>, [Record<string, unknown>]>(),
  };
  const transcriptionClient = {
    getJob: jest.fn((id: string) =>
      Promise.resolve({
        externalId: id,
        status: 'completed',
        text: `transcript for ${id}`,
        language: 'en',
        wordCount: 3,
        error: null,
        segments: [{ start: 0, end: 1.5, text: `transcript for ${id}` }],
      }),
    ),
    removeAudio: jest.fn(),
    audioPathFor: (interviewId: string, answerId: string) => ({
      relativePath: `interviews/${interviewId}/${answerId}.mp4`,
      absolutePath: `/audio/interviews/${interviewId}/${answerId}.mp4`,
    }),
    language: 'en',
  };
  const evaluationProducer = { enqueue: jest.fn() };

  const assembly = new TranscriptAssemblyService(
    interviewsRepository as never,
    answersRepository as never,
    transcriptsRepository as never,
    transcriptionClient as never,
    evaluationProducer as never,
  );
  const processor = new TranscriptionEventsProcessor(
    answersRepository as never,
    transcriptionClient as never,
    assembly,
  );
  const send = (data: Partial<TranscriptionEventPayload>) =>
    processor.process({ data } as Job<TranscriptionEventPayload>);

  return {
    rows,
    send,
    answersRepository,
    transcriptsRepository,
    transcriptionClient,
    evaluationProducer,
  };
}

const pending = (id: string, questionId: string): AnswerRow => ({
  id,
  interviewId: INTERVIEW_ID,
  interviewQuestionId: questionId,
  transcriptionStatus: AnswerTranscriptionStatus.PENDING,
});

describe('TranscriptionEventsProcessor', () => {
  it('saves the transcript from the API and waits until every answer is done', async () => {
    const t = setup([pending(ANSWER_1, 'q1'), pending(ANSWER_2, 'q2')]);

    await t.send({ event: 'transcription.completed', externalId: ANSWER_1 });

    expect(t.rows.get(ANSWER_1)).toMatchObject({
      transcriptionStatus: AnswerTranscriptionStatus.COMPLETED,
      transcriptText: `transcript for ${ANSWER_1}`,
      status: InterviewAnswerStatus.TRANSCRIBED,
    });
    expect(t.transcriptionClient.removeAudio).toHaveBeenCalledWith(
      `interviews/${INTERVIEW_ID}/${ANSWER_1}.mp4`,
    );
    // Answer 2 is still pending — nothing assembled yet.
    expect(t.transcriptsRepository.insert).not.toHaveBeenCalled();
    expect(t.evaluationProducer.enqueue).not.toHaveBeenCalled();
  });

  it('assembles the interview transcript in question order and enqueues evaluation', async () => {
    const t = setup([pending(ANSWER_2, 'q2'), pending(ANSWER_1, 'q1')]);

    await t.send({ event: 'transcription.completed', externalId: ANSWER_2 });
    await t.send({ event: 'transcription.completed', externalId: ANSWER_1 });

    expect(t.transcriptsRepository.insert).toHaveBeenCalledTimes(1);
    expect(t.transcriptsRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        interviewId: INTERVIEW_ID,
        perQuestion: [
          { questionId: 'q1', transcriptText: `transcript for ${ANSWER_1}` },
          { questionId: 'q2', transcriptText: `transcript for ${ANSWER_2}` },
        ],
      }),
    );
    expect(t.transcriptsRepository.insert.mock.calls[0][0]).not.toHaveProperty('failureReason');
    expect(t.evaluationProducer.enqueue).toHaveBeenCalledWith({
      interviewId: INTERVIEW_ID,
      candidateId: 'cand-1',
      organizationId: 'org-1',
    });
  });

  it('ignores a duplicate event for an answer that is no longer pending', async () => {
    const t = setup([
      { ...pending(ANSWER_1, 'q1'), transcriptionStatus: AnswerTranscriptionStatus.COMPLETED },
    ]);

    await t.send({ event: 'transcription.completed', externalId: ANSWER_1 });

    expect(t.transcriptionClient.getJob).not.toHaveBeenCalled();
    expect(t.answersRepository.update).not.toHaveBeenCalled();
  });

  it('ignores events for ids that are not interview answers', async () => {
    const t = setup([pending(ANSWER_1, 'q1')]);

    await t.send({ event: 'transcription.completed', externalId: 'rec-4f2a' });
    await t.send({
      event: 'transcription.completed',
      externalId: '44444444-4444-4444-8444-444444444444',
    });

    // Non-UUID never reaches the DB (a uuid column would throw on it).
    expect(t.answersRepository.findOne).toHaveBeenCalledTimes(1);
    expect(t.answersRepository.update).not.toHaveBeenCalled();
  });

  it('records a failure row when every answer failed, without enqueueing evaluation', async () => {
    const t = setup([pending(ANSWER_1, 'q1')]);

    await t.send({
      event: 'transcription.failed',
      externalId: ANSWER_1,
      error: 'ProviderError: Deepgram returned 401',
    });

    expect(t.rows.get(ANSWER_1)).toMatchObject({
      transcriptionStatus: AnswerTranscriptionStatus.FAILED,
      transcriptionError: 'ProviderError: Deepgram returned 401',
    });
    expect(t.transcriptsRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: 'ProviderError: Deepgram returned 401' }),
    );
    expect(t.evaluationProducer.enqueue).not.toHaveBeenCalled();
  });

  it('still evaluates when only some answers failed', async () => {
    const t = setup([pending(ANSWER_1, 'q1'), pending(ANSWER_2, 'q2')]);

    await t.send({ event: 'transcription.failed', externalId: ANSWER_1, error: 'bad audio' });
    await t.send({ event: 'transcription.completed', externalId: ANSWER_2 });

    expect(t.transcriptsRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        perQuestion: [{ questionId: 'q2', transcriptText: `transcript for ${ANSWER_2}` }],
      }),
    );
    expect(t.evaluationProducer.enqueue).toHaveBeenCalledTimes(1);
  });

  it('retries (throws) when the API does not have the completed job yet', async () => {
    const t = setup([pending(ANSWER_1, 'q1')]);
    t.transcriptionClient.getJob.mockResolvedValueOnce(null as never);

    await expect(
      t.send({ event: 'transcription.completed', externalId: ANSWER_1 }),
    ).rejects.toThrow();
    expect(t.rows.get(ANSWER_1)?.transcriptionStatus).toBe(AnswerTranscriptionStatus.PENDING);
  });
});
