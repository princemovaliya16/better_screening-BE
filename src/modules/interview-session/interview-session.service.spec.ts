import { EgressInfo, EgressStatus, WebhookEvent } from 'livekit-server-sdk';
import { InterviewStatus } from '@module/interviews/entities';
import { InterviewAnswerStatus } from './entities';
import { InterviewSessionService } from './interview-session.service';

function makeService() {
  const interviewsRepository = { findOne: jest.fn(), update: jest.fn() };
  const tokensRepository = { update: jest.fn() };
  const answersRepository = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
  };
  const transcriptsRepository = { findOne: jest.fn() };
  const storageService = { recordingsBucket: 'recordings', getSignedDownloadUrl: jest.fn() };
  const livekitService = {
    stopEgress: jest.fn(),
    removeParticipant: jest.fn(),
    getEgress: jest.fn(),
  };
  const producer = { enqueueForInterview: jest.fn() };

  const service = new InterviewSessionService(
    interviewsRepository as never,
    tokensRepository as never,
    answersRepository as never,
    transcriptsRepository as never,
    storageService as never,
    livekitService as never,
    producer as never,
  );
  return { service, interviewsRepository, answersRepository, livekitService, producer };
}

function egressEnded(status: EgressStatus, file?: { size?: bigint; duration?: bigint }, error = ''): WebhookEvent {
  return {
    event: 'egress_ended',
    egressInfo: new EgressInfo({
      egressId: 'EG_1',
      status,
      error,
      fileResults: file ? [file] : [],
    }),
  } as unknown as WebhookEvent;
}

const processingAnswer = {
  id: 'answer-1',
  interviewId: 'interview-1',
  egressId: 'EG_1',
  status: InterviewAnswerStatus.PROCESSING,
  recordingEndedAt: new Date(),
};

describe('InterviewSessionService — LiveKit egress webhooks', () => {
  it('marks a completed egress UPLOADED with size and duration, then enqueues transcription', async () => {
    const { service, interviewsRepository, answersRepository, producer } = makeService();
    answersRepository.findOne.mockResolvedValue({ ...processingAnswer });
    interviewsRepository.findOne.mockResolvedValue({
      id: 'interview-1',
      status: InterviewStatus.PENDING_EVALUATION,
    });

    await service.handleLivekitWebhook(
      egressEnded(EgressStatus.EGRESS_COMPLETE, {
        size: BigInt(2_000_000),
        duration: BigInt(42_400_000_000), // 42.4s in ns
      }),
    );

    expect(answersRepository.update).toHaveBeenCalledWith(
      'answer-1',
      expect.objectContaining({
        status: InterviewAnswerStatus.UPLOADED,
        recordingSizeBytes: 2_000_000,
        recordingDurationSeconds: 42,
      }),
    );
    expect(producer.enqueueForInterview).toHaveBeenCalledWith('interview-1');
  });

  it('ignores a duplicate egress_ended for an answer that is already final', async () => {
    const { service, answersRepository, producer } = makeService();
    answersRepository.findOne.mockResolvedValue({
      ...processingAnswer,
      status: InterviewAnswerStatus.UPLOADED,
    });

    await service.handleLivekitWebhook(
      egressEnded(EgressStatus.EGRESS_COMPLETE, { size: BigInt(1), duration: BigInt(1) }),
    );

    expect(answersRepository.update).not.toHaveBeenCalled();
    expect(producer.enqueueForInterview).not.toHaveBeenCalled();
  });

  it('ignores an egress it has no answer for (e.g. superseded by a re-record)', async () => {
    const { service, answersRepository } = makeService();
    answersRepository.findOne.mockResolvedValue(null);

    await service.handleLivekitWebhook(
      egressEnded(EgressStatus.EGRESS_COMPLETE, { size: BigInt(1) }),
    );

    expect(answersRepository.update).not.toHaveBeenCalled();
  });

  it('marks a failed egress FAILED with the reason so the question can be re-recorded', async () => {
    const { service, interviewsRepository, answersRepository } = makeService();
    answersRepository.findOne.mockResolvedValue({ ...processingAnswer });
    interviewsRepository.findOne.mockResolvedValue({
      id: 'interview-1',
      status: InterviewStatus.IN_PROGRESS,
    });

    await service.handleLivekitWebhook(
      egressEnded(EgressStatus.EGRESS_FAILED, undefined, 'participant disconnected'),
    );

    expect(answersRepository.update).toHaveBeenCalledWith(
      'answer-1',
      expect.objectContaining({
        status: InterviewAnswerStatus.FAILED,
        failureReason: 'participant disconnected',
      }),
    );
  });
});

describe('InterviewSessionService.maybeEnqueueTranscription', () => {
  it('waits while any recording is still pending', async () => {
    const { service, interviewsRepository, answersRepository, producer } = makeService();
    interviewsRepository.findOne.mockResolvedValue({
      id: 'interview-1',
      status: InterviewStatus.PENDING_EVALUATION,
    });
    answersRepository.count.mockResolvedValue(1);

    await service.maybeEnqueueTranscription('interview-1');

    expect(producer.enqueueForInterview).not.toHaveBeenCalled();
  });

  it('does nothing until the round has been submitted', async () => {
    const { service, interviewsRepository, producer } = makeService();
    interviewsRepository.findOne.mockResolvedValue({
      id: 'interview-1',
      status: InterviewStatus.IN_PROGRESS,
    });

    await service.maybeEnqueueTranscription('interview-1');

    expect(producer.enqueueForInterview).not.toHaveBeenCalled();
  });

  it('enqueues once submitted and every recording has settled', async () => {
    const { service, interviewsRepository, producer } = makeService();
    interviewsRepository.findOne.mockResolvedValue({
      id: 'interview-1',
      status: InterviewStatus.PENDING_EVALUATION,
    });

    await service.maybeEnqueueTranscription('interview-1');

    expect(producer.enqueueForInterview).toHaveBeenCalledWith('interview-1');
  });
});
