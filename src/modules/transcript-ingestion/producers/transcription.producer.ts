import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { In, Repository } from 'typeorm';
import { QUEUE_NAMES, TranscriptionJobPayload } from '@core/queue';
import { StorageService } from '@core/storage';
import { TranscriptionClientService } from '@core/transcription';
import {
  AnswerTranscriptionStatus,
  InterviewAnswer,
  PLAYABLE_STATUSES,
} from '@module/interview-session/entities';
import { TranscriptAssemblyService } from '../transcript-assembly.service';

/**
 * Hands a submitted interview's recordings to the transcription service
 * (`transcript/`, see its docs/INTEGRATION.md): one `transcription` job per answer.
 * The service only reads audio from its shared folder (no URLs), so each MP4 is first
 * copied out of the recordings bucket into TRANSCRIPTION_AUDIO_DIR.
 */
@Injectable()
export class TranscriptionProducerService {
  private readonly logger = new Logger(TranscriptionProducerService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.TRANSCRIPTION)
    private readonly queue: Queue<TranscriptionJobPayload>,
    @InjectRepository(InterviewAnswer)
    private readonly answersRepository: Repository<InterviewAnswer>,
    private readonly storageService: StorageService,
    private readonly transcriptionClient: TranscriptionClientService,
    private readonly transcriptAssembly: TranscriptAssemblyService,
  ) {}

  /** Safe to call more than once: answers already handed over are skipped. */
  async enqueueForInterview(interviewId: string): Promise<void> {
    const answers = await this.answersRepository.find({
      where: { interviewId, status: In(PLAYABLE_STATUSES) },
    });
    if (answers.length === 0) {
      this.logger.warn(
        `enqueueForInterview: interview ${interviewId} has no recordings — skipping`,
      );
      return;
    }

    for (const answer of answers.filter((a) => !a.transcriptionStatus)) {
      const { relativePath, absolutePath } = this.transcriptionClient.audioPathFor(
        interviewId,
        answer.id,
      );
      try {
        await this.storageService.downloadToFile(
          this.storageService.recordingsBucket,
          answer.recordingStoragePath,
          absolutePath,
        );
        // Mark pending *before* queueing so a fast completion event can't arrive
        // while the answer still looks un-sent (the consumer ignores non-pending ones).
        await this.answersRepository.update(answer.id, {
          transcriptionStatus: AnswerTranscriptionStatus.PENDING,
          transcriptionError: null,
        });
        await this.queue.add(
          'transcribe',
          {
            id: answer.id,
            audioPath: relativePath,
            language: this.transcriptionClient.language,
            metadata: {
              interviewId,
              answerId: answer.id,
              questionId: answer.interviewQuestionId,
              organizationId: answer.organizationId,
            },
          },
          {
            // Dedupes while the job is still known to Redis; the service also skips
            // an id it has already completed.
            jobId: answer.id,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Could not hand answer ${answer.id} to the transcription service: ${reason}`,
        );
        await this.answersRepository.update(answer.id, {
          transcriptionStatus: AnswerTranscriptionStatus.FAILED,
          transcriptionError: `Could not send the recording for transcription: ${reason}`,
        });
        await this.transcriptionClient.removeAudio(relativePath);
      }
    }
    this.logger.log(`Enqueued transcription for interview ${interviewId}`);

    // No-op while anything is pending; records the failure right away if nothing
    // could be sent, rather than leaving the interview "transcribing" forever.
    await this.transcriptAssembly.finalizeInterviewTranscript(interviewId);
  }
}
