import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EgressInfo, EgressStatus, WebhookEvent } from 'livekit-server-sdk';
import { In, Repository } from 'typeorm';
import { hashToken, randomToken } from '@core/utils/crypt.util';
import { LivekitService } from '@core/livekit';
import { StorageService } from '@core/storage';
import { Interview, InterviewStatus } from '@module/interviews/entities';
import { InterviewTranscript, TranscriptionProducerService } from '@module/transcript-ingestion';
import {
  ANSWERED_STATUSES,
  AccessTokenStatus,
  AnswerTranscriptionStatus,
  InterviewAccessToken,
  InterviewAnswer,
  InterviewAnswerStatus,
  PLAYABLE_STATUSES,
} from './entities';
import { CandidateSessionContext } from './types/candidate-session-context.type';

const ACCESS_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const ROOM_PREFIX = 'interview-';
const RECORDING_MIME_TYPE = 'video/mp4';
/** Grace period on the LiveKit token past the round deadline, so a candidate who is
 * mid-answer when time runs out isn't cut off before the auto-submit lands. */
const LIVEKIT_TOKEN_GRACE_SECONDS = 5 * 60;
/** How long a PROCESSING answer may wait for its egress_ended webhook before we ask
 * LiveKit directly (covers a missed/undelivered webhook). */
const EGRESS_RECONCILE_AFTER_MS = 60_000;

/** Final states — a webhook for an answer already here is a duplicate and ignored. */
const FINAL_STATUSES: InterviewAnswerStatus[] = [
  ...PLAYABLE_STATUSES,
  InterviewAnswerStatus.FAILED,
];
const PENDING_STATUSES: InterviewAnswerStatus[] = [
  InterviewAnswerStatus.RECORDING,
  InterviewAnswerStatus.PROCESSING,
];

export interface CandidateSessionQuestion {
  id: string;
  orderIndex: number;
  questionText: string;
  questionType: string;
  answered: boolean;
}

export interface CandidateSessionResponse {
  status: 'active' | 'submitted';
  roundName: string;
  jobTitle: string;
  candidateName: string;
  durationMinutes: number;
  startedAt: string | null;
  deadlineAt: string | null;
  questions: CandidateSessionQuestion[];
}

export interface LivekitJoinResponse {
  wsUrl: string;
  token: string;
  roomName: string;
  startedAt: string;
  deadlineAt: string;
}

export interface InterviewRecordingItem {
  questionId: string;
  orderIndex: number;
  questionText: string;
  status: InterviewAnswerStatus | 'not_recorded';
  durationSeconds: number | null;
  mimeType: string | null;
  playbackUrl: string | null;
  transcriptText: string | null;
  /** null until the round is submitted and the recording is sent for transcription. */
  transcriptionStatus: AnswerTranscriptionStatus | null;
  transcriptionError: string | null;
  failureReason: string | null;
}

@Injectable()
export class InterviewSessionService {
  private readonly logger = new Logger(InterviewSessionService.name);

  constructor(
    @InjectRepository(Interview)
    private readonly interviewsRepository: Repository<Interview>,
    @InjectRepository(InterviewAccessToken)
    private readonly tokensRepository: Repository<InterviewAccessToken>,
    @InjectRepository(InterviewAnswer)
    private readonly answersRepository: Repository<InterviewAnswer>,
    @InjectRepository(InterviewTranscript)
    private readonly transcriptsRepository: Repository<InterviewTranscript>,
    private readonly storageService: StorageService,
    private readonly livekitService: LivekitService,
    private readonly transcriptionProducer: TranscriptionProducerService,
  ) {}

  // ---- Called by InterviewsModule when a recruiter sends an invitation ----

  async issueAccessToken(interview: {
    id: string;
    candidateId: string;
    organizationId: string;
  }): Promise<string> {
    const rawToken = randomToken();
    await this.tokensRepository.save(
      this.tokensRepository.create({
        interviewId: interview.id,
        candidateId: interview.candidateId,
        organizationId: interview.organizationId,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_MS),
        status: AccessTokenStatus.ACTIVE,
      }),
    );
    return rawToken;
  }

  /** Called when a recruiter cancels an interview — closes off a link that might
   * still be sitting in the candidate's inbox. */
  async revokeTokensForInterview(interviewId: string): Promise<void> {
    await this.tokensRepository.update(
      { interviewId, status: AccessTokenStatus.ACTIVE },
      { status: AccessTokenStatus.REVOKED },
    );
  }

  // ---- Helpers ----

  private roomNameFor(interviewId: string): string {
    return `${ROOM_PREFIX}${interviewId}`;
  }

  private candidateIdentityFor(candidateId: string): string {
    return `candidate-${candidateId}`;
  }

  private async loadInterview(interviewId: string): Promise<Interview> {
    const interview = await this.interviewsRepository.findOne({
      where: { id: interviewId },
      relations: { candidate: true, job: true, questions: true },
      order: { questions: { orderIndex: 'ASC' } },
    });
    if (!interview) throw new NotFoundException('Interview not found');
    return interview;
  }

  private deadlineFor(interview: Interview): Date | null {
    if (!interview.startedAt) return null;
    return new Date(interview.startedAt.getTime() + interview.durationMinutes * 60_000);
  }

  private isSubmitted(interview: Interview): boolean {
    return (
      interview.status === InterviewStatus.PENDING_EVALUATION ||
      interview.status === InterviewStatus.COMPLETED
    );
  }

  /** If the round is running and its deadline has passed, auto-submit it. Called at
   * the top of every candidate-facing action (and on LiveKit participant_left) so a
   * stale/abandoned session can't keep recording past its allotted time. */
  private async enforceDeadline(interview: Interview): Promise<Interview> {
    if (interview.status !== InterviewStatus.IN_PROGRESS) return interview;
    const deadline = this.deadlineFor(interview);
    if (deadline && new Date() > deadline) {
      await this.finalizeSubmit(interview.id, true);
      return this.loadInterview(interview.id);
    }
    return interview;
  }

  /** Stops every egress still recording for this interview; those answers move to
   * PROCESSING and are confirmed (or failed) by their egress_ended webhook. */
  private async stopActiveRecordings(interviewId: string): Promise<void> {
    const recording = await this.answersRepository.find({
      where: { interviewId, status: InterviewAnswerStatus.RECORDING },
    });
    for (const answer of recording) {
      if (answer.egressId) await this.livekitService.stopEgress(answer.egressId);
      await this.answersRepository.update(answer.id, {
        status: InterviewAnswerStatus.PROCESSING,
        recordingEndedAt: new Date(),
      });
    }
  }

  private async finalizeSubmit(interviewId: string, isAutoSubmit: boolean): Promise<void> {
    const interview = await this.interviewsRepository.findOne({ where: { id: interviewId } });
    await this.stopActiveRecordings(interviewId);
    await this.interviewsRepository.update(interviewId, {
      status: InterviewStatus.PENDING_EVALUATION,
      ...(isAutoSubmit ? { autoSubmittedAt: new Date() } : {}),
    });
    await this.tokensRepository.update(
      { interviewId, status: AccessTokenStatus.ACTIVE },
      { status: AccessTokenStatus.USED, consumedAt: new Date() },
    );
    if (interview) {
      await this.livekitService.removeParticipant(
        this.roomNameFor(interviewId),
        this.candidateIdentityFor(interview.candidateId),
      );
    }
    await this.maybeEnqueueTranscription(interviewId);
  }

  /** Hands off to the transcription service once the round is submitted AND every recording has
   * settled (uploaded or failed). Called from submit and from each egress_ended
   * webhook, so whichever happens last triggers it; the producer dedupes by jobId. */
  async maybeEnqueueTranscription(interviewId: string): Promise<void> {
    const interview = await this.interviewsRepository.findOne({ where: { id: interviewId } });
    if (!interview || interview.status !== InterviewStatus.PENDING_EVALUATION) return;
    const pending = await this.answersRepository.count({
      where: { interviewId, status: In(PENDING_STATUSES) },
    });
    if (pending > 0) return;
    await this.transcriptionProducer.enqueueForInterview(interviewId);
  }

  // ---- Candidate-facing ----

  async getSession(session: CandidateSessionContext): Promise<CandidateSessionResponse> {
    let interview = await this.loadInterview(session.interviewId);
    interview = await this.enforceDeadline(interview);

    if (interview.status === InterviewStatus.CANCELLED) {
      throw new BadRequestException('This interview has been cancelled');
    }

    const answers = await this.answersRepository.find({ where: { interviewId: interview.id } });
    const answeredIds = new Set(
      answers.filter((a) => ANSWERED_STATUSES.includes(a.status)).map((a) => a.interviewQuestionId),
    );

    return {
      status: this.isSubmitted(interview) ? 'submitted' : 'active',
      roundName: interview.roundName,
      jobTitle: interview.job?.title ?? '',
      candidateName: interview.candidate?.name ?? '',
      durationMinutes: interview.durationMinutes,
      startedAt: interview.startedAt?.toISOString() ?? null,
      deadlineAt: this.deadlineFor(interview)?.toISOString() ?? null,
      questions: (interview.questions ?? [])
        .slice()
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .map((q) => ({
          id: q.id,
          orderIndex: q.orderIndex,
          questionText: q.questionText,
          questionType: q.questionType,
          answered: answeredIds.has(q.id),
        })),
    };
  }

  /** The candidate pressed "Start interview": open (or reopen) their LiveKit room and
   * start the round clock if it isn't running yet. Rejoining mid-round keeps the
   * original deadline. */
  async joinRoom(session: CandidateSessionContext): Promise<LivekitJoinResponse> {
    let interview = await this.loadInterview(session.interviewId);
    interview = await this.enforceDeadline(interview);

    if (interview.status === InterviewStatus.CANCELLED) {
      throw new BadRequestException('This interview has been cancelled');
    }
    if (this.isSubmitted(interview)) {
      throw new BadRequestException('This interview has already been submitted');
    }

    const roomName = this.roomNameFor(interview.id);
    try {
      await this.livekitService.ensureRoom(roomName);
    } catch (err) {
      this.logger.error(
        `LiveKit unavailable for interview ${interview.id}`,
        err instanceof Error ? err.stack : err,
      );
      throw new ServiceUnavailableException(
        'The interview room is temporarily unavailable. Please try again in a moment.',
      );
    }

    // First join starts the clock — this is when the candidate actually begins.
    if (
      interview.status === InterviewStatus.SCHEDULED ||
      interview.status === InterviewStatus.INVITATION_SENT
    ) {
      await this.interviewsRepository.update(interview.id, {
        status: InterviewStatus.IN_PROGRESS,
        startedAt: new Date(),
      });
      interview = await this.loadInterview(interview.id);
    }
    if (interview.status !== InterviewStatus.IN_PROGRESS) {
      throw new BadRequestException('This interview session is not active');
    }

    const deadline = this.deadlineFor(interview)!;
    const ttlSeconds =
      Math.max(60, Math.ceil((deadline.getTime() - Date.now()) / 1000)) +
      LIVEKIT_TOKEN_GRACE_SECONDS;
    const token = await this.livekitService.createCandidateToken({
      roomName,
      identity: this.candidateIdentityFor(interview.candidateId),
      name: interview.candidate?.name ?? 'Candidate',
      ttlSeconds,
    });

    return {
      wsUrl: this.livekitService.wsUrl,
      token,
      roomName,
      startedAt: interview.startedAt!.toISOString(),
      deadlineAt: deadline.toISOString(),
    };
  }

  private async assertActiveAndFindQuestion(session: CandidateSessionContext, questionId: string) {
    let interview = await this.loadInterview(session.interviewId);
    interview = await this.enforceDeadline(interview);
    if (interview.status !== InterviewStatus.IN_PROGRESS) {
      throw new BadRequestException('This interview session is no longer active');
    }
    const question = interview.questions?.find((q) => q.id === questionId);
    if (!question) throw new NotFoundException('Question not found for this interview');
    return { interview, question };
  }

  /** Starts a server-side egress recording of the candidate for one question. Only one
   * recording runs per interview at a time; re-recording a question overwrites it. */
  async startRecording(
    session: CandidateSessionContext,
    questionId: string,
  ): Promise<{ questionId: string; status: InterviewAnswerStatus }> {
    const { interview } = await this.assertActiveAndFindQuestion(session, questionId);

    // Anything still recording (e.g. the candidate reloaded mid-answer) is abandoned:
    // for this question it's about to be replaced, for another it must be redone.
    const stillRecording = await this.answersRepository.find({
      where: { interviewId: interview.id, status: InterviewAnswerStatus.RECORDING },
    });
    for (const answer of stillRecording) {
      if (answer.egressId) await this.livekitService.stopEgress(answer.egressId);
      if (answer.interviewQuestionId !== questionId) {
        await this.answersRepository.update(answer.id, {
          status: InterviewAnswerStatus.FAILED,
          failureReason: 'Recording was interrupted',
          recordingEndedAt: new Date(),
        });
      }
    }

    const storageKey = `org/${interview.organizationId}/interviews/${interview.id}/questions/${questionId}/${randomToken(8)}.mp4`;
    let egressId: string;
    try {
      const info = await this.livekitService.startParticipantRecording({
        roomName: this.roomNameFor(interview.id),
        identity: this.candidateIdentityFor(interview.candidateId),
        bucket: this.storageService.recordingsBucket,
        filepath: storageKey,
      });
      egressId = info.egressId;
    } catch (err) {
      this.logger.error(
        `startParticipantRecording failed for interview ${interview.id}`,
        err instanceof Error ? err.stack : err,
      );
      throw new BadRequestException(
        'We could not start recording — check your connection and try again.',
      );
    }

    const fields = {
      recordingStoragePath: storageKey,
      recordingMimeType: RECORDING_MIME_TYPE,
      recordingDurationSeconds: null,
      recordingSizeBytes: null,
      status: InterviewAnswerStatus.RECORDING,
      egressId,
      recordingStartedAt: new Date(),
      recordingEndedAt: null,
      failureReason: null,
    };
    const existing = await this.answersRepository.findOne({
      where: { interviewId: interview.id, interviewQuestionId: questionId },
    });
    if (existing) {
      await this.answersRepository.update(existing.id, fields);
    } else {
      await this.answersRepository.save(
        this.answersRepository.create({
          interviewId: interview.id,
          interviewQuestionId: questionId,
          organizationId: interview.organizationId,
          ...fields,
        }),
      );
    }
    return { questionId, status: InterviewAnswerStatus.RECORDING };
  }

  /** Stops the question's recording. Returns immediately — the file is confirmed
   * asynchronously by the egress_ended webhook. Safe to call after the deadline
   * (the auto-submit has already stopped it) or twice. */
  async stopRecording(
    session: CandidateSessionContext,
    questionId: string,
  ): Promise<{ questionId: string; status: InterviewAnswerStatus }> {
    let interview = await this.loadInterview(session.interviewId);
    interview = await this.enforceDeadline(interview);

    const answer = await this.answersRepository.findOne({
      where: { interviewId: interview.id, interviewQuestionId: questionId },
    });
    if (!answer) throw new NotFoundException('No recording found for this question');
    if (answer.status !== InterviewAnswerStatus.RECORDING) {
      return { questionId, status: answer.status };
    }

    if (answer.egressId) await this.livekitService.stopEgress(answer.egressId);
    await this.answersRepository.update(answer.id, {
      status: InterviewAnswerStatus.PROCESSING,
      recordingEndedAt: new Date(),
    });
    return { questionId, status: InterviewAnswerStatus.PROCESSING };
  }

  async submit(session: CandidateSessionContext): Promise<{ status: 'submitted' }> {
    let interview = await this.loadInterview(session.interviewId);
    interview = await this.enforceDeadline(interview);

    if (this.isSubmitted(interview)) {
      return { status: 'submitted' }; // idempotent — candidate double-clicked, or already auto-submitted
    }
    if (interview.status !== InterviewStatus.IN_PROGRESS) {
      throw new BadRequestException('This interview session is not active');
    }
    await this.finalizeSubmit(interview.id, false);
    return { status: 'submitted' };
  }

  // ---- LiveKit webhooks ----

  async handleLivekitWebhook(event: WebhookEvent): Promise<void> {
    switch (event.event) {
      case 'egress_ended':
        if (event.egressInfo) await this.applyEgressResult(event.egressInfo);
        return;
      case 'participant_left':
      case 'room_finished': {
        // Candidate left — if their time is up, this is the moment to auto-submit
        // rather than waiting for them to come back.
        const roomName = event.room?.name ?? '';
        if (!roomName.startsWith(ROOM_PREFIX)) return;
        const interview = await this.interviewsRepository.findOne({
          where: { id: roomName.slice(ROOM_PREFIX.length) },
        });
        if (interview) await this.enforceDeadline(interview);
        return;
      }
      default:
        return;
    }
  }

  /** Applies an ended egress to its answer row. Idempotent: duplicate or late events
   * for an answer already in a final state (or re-recorded under a new egress) are
   * ignored. */
  private async applyEgressResult(info: EgressInfo): Promise<void> {
    const answer = await this.answersRepository.findOne({ where: { egressId: info.egressId } });
    if (!answer || FINAL_STATUSES.includes(answer.status)) return;

    const file = info.fileResults?.[0];
    const succeeded =
      (info.status === EgressStatus.EGRESS_COMPLETE ||
        info.status === EgressStatus.EGRESS_LIMIT_REACHED) &&
      !!file;
    const failed =
      info.status === EgressStatus.EGRESS_FAILED ||
      info.status === EgressStatus.EGRESS_ABORTED ||
      (info.status === EgressStatus.EGRESS_COMPLETE && !file);

    if (succeeded) {
      await this.answersRepository.update(answer.id, {
        status: InterviewAnswerStatus.UPLOADED,
        recordingSizeBytes: Number(file.size) || null,
        // egress reports duration in nanoseconds
        recordingDurationSeconds: Math.round(Number(file.duration) / 1e9) || null,
        recordingEndedAt: answer.recordingEndedAt ?? new Date(),
      });
    } else if (failed) {
      this.logger.warn(`Egress ${info.egressId} ended with status ${info.status}: ${info.error}`);
      await this.answersRepository.update(answer.id, {
        status: InterviewAnswerStatus.FAILED,
        failureReason: info.error || 'Recording failed',
        recordingEndedAt: answer.recordingEndedAt ?? new Date(),
      });
    } else {
      return; // still starting/active/ending — not actually over yet
    }
    await this.maybeEnqueueTranscription(answer.interviewId);
  }

  /** Safety net for a missed webhook: asks LiveKit directly about answers that have
   * been PROCESSING for a while. */
  private async reconcileStaleRecordings(answers: InterviewAnswer[]): Promise<boolean> {
    const cutoff = Date.now() - EGRESS_RECONCILE_AFTER_MS;
    const stale = answers.filter(
      (a) =>
        a.status === InterviewAnswerStatus.PROCESSING &&
        a.egressId &&
        (a.recordingEndedAt?.getTime() ?? 0) < cutoff,
    );
    let changed = false;
    for (const answer of stale) {
      try {
        const info = await this.livekitService.getEgress(answer.egressId!);
        if (info) {
          await this.applyEgressResult(info);
          changed = true;
        }
      } catch (err) {
        this.logger.warn(
          `Could not reconcile egress ${answer.egressId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return changed;
  }

  // ---- Recruiter-facing (called by InterviewsModule; org-scoped) ----

  async listRecordingsForRecruiter(
    organizationId: string,
    interviewId: string,
  ): Promise<InterviewRecordingItem[]> {
    const interview = await this.interviewsRepository.findOne({
      where: { id: interviewId, organizationId },
      relations: { questions: true },
    });
    if (!interview) throw new NotFoundException('Interview not found');

    let answers = await this.answersRepository.find({ where: { interviewId } });
    if (await this.reconcileStaleRecordings(answers)) {
      answers = await this.answersRepository.find({ where: { interviewId } });
    }
    const answerByQuestionId = new Map(answers.map((a) => [a.interviewQuestionId, a]));

    const transcript = await this.transcriptsRepository.findOne({ where: { interviewId } });
    const transcriptByQuestionId = new Map(
      (transcript?.perQuestion ?? []).map((p) => [p.questionId, p.transcriptText]),
    );

    return Promise.all(
      (interview.questions ?? [])
        .slice()
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .map(async (q) => {
          const answer = answerByQuestionId.get(q.id);
          const playable = !!answer && PLAYABLE_STATUSES.includes(answer.status);
          return {
            questionId: q.id,
            orderIndex: q.orderIndex,
            questionText: q.questionText,
            status: answer?.status ?? 'not_recorded',
            durationSeconds: answer?.recordingDurationSeconds ?? null,
            mimeType: answer?.recordingMimeType ?? null,
            playbackUrl: playable
              ? await this.storageService.getSignedDownloadUrl(
                  this.storageService.recordingsBucket,
                  answer.recordingStoragePath,
                )
              : null,
            // Per-answer text appears as soon as that answer is transcribed.
            transcriptText: answer?.transcriptText ?? transcriptByQuestionId.get(q.id) ?? null,
            transcriptionStatus: answer?.transcriptionStatus ?? null,
            transcriptionError: answer?.transcriptionError ?? null,
            failureReason: answer?.failureReason ?? null,
          };
        }),
    );
  }
}
