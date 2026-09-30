import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { QUEUE_NAMES, TranscriptionEventPayload } from '@core/queue';
import { TranscriptionClientService } from '@core/transcription';
import {
  AnswerTranscriptionStatus,
  InterviewAnswer,
  InterviewAnswerStatus,
} from '@module/interview-session/entities';
import { TranscriptAssemblyService } from '../transcript-assembly.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Consumes `transcription-events` from the transcription service. Each event is for
 * one answer (`externalId` = our answer id) and carries no text, so on completion the
 * transcript is read from the service's HTTP API. Saves it on the answer, removes the
 * copied audio, and assembles the interview transcript once every answer is done.
 *
 * Idempotent against BullMQ's at-least-once delivery: only an answer still `pending`
 * is updated. Events for ids that aren't ours (the Redis may be shared) are ignored.
 */
@Processor(QUEUE_NAMES.TRANSCRIPTION_EVENTS)
export class TranscriptionEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(TranscriptionEventsProcessor.name);

  constructor(
    @InjectRepository(InterviewAnswer)
    private readonly answersRepository: Repository<InterviewAnswer>,
    private readonly transcriptionClient: TranscriptionClientService,
    private readonly transcriptAssembly: TranscriptAssemblyService,
  ) {
    super();
  }

  async process(job: Job<TranscriptionEventPayload>): Promise<void> {
    const { event, externalId, error } = job.data ?? ({} as TranscriptionEventPayload);
    if (!externalId || !UUID_RE.test(externalId)) {
      this.logger.debug(`Ignoring transcription event for non-interview id ${externalId}`);
      return;
    }
    const answer = await this.answersRepository.findOne({ where: { id: externalId } });
    if (!answer || answer.transcriptionStatus !== AnswerTranscriptionStatus.PENDING) return;

    if (event === 'transcription.completed') {
      const result = await this.transcriptionClient.getJob(externalId);
      if (!result || result.status !== 'completed') {
        // Event says done but the API disagrees — throw so BullMQ retries shortly.
        throw new Error(`Transcription API has no completed job for ${externalId} yet`);
      }
      await this.answersRepository.update(answer.id, {
        transcriptionStatus: AnswerTranscriptionStatus.COMPLETED,
        transcriptText: result.text ?? '',
        transcriptSegments: result.segments,
        transcriptionError: null,
        status: InterviewAnswerStatus.TRANSCRIBED,
      });
    } else if (event === 'transcription.failed') {
      this.logger.warn(`Transcription failed for answer ${answer.id}: ${error ?? 'unknown error'}`);
      await this.answersRepository.update(answer.id, {
        transcriptionStatus: AnswerTranscriptionStatus.FAILED,
        transcriptionError: error ?? 'Transcription failed',
      });
    } else {
      return;
    }

    await this.transcriptionClient.removeAudio(
      this.transcriptionClient.audioPathFor(answer.interviewId, answer.id).relativePath,
    );
    await this.transcriptAssembly.finalizeInterviewTranscript(answer.interviewId);
  }
}
