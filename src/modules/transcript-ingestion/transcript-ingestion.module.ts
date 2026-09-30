import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '@core/queue';
import { Interview } from '@module/interviews/entities';
import { InterviewAnswer } from '@module/interview-session/entities';
import { InterviewTranscript } from './entities';
import { EvaluationProcessingProducerService } from './producers/evaluation-processing.producer';
import { TranscriptionProducerService } from './producers/transcription.producer';
import { TranscriptionEventsProcessor } from './processors/transcription-events.processor';
import { TranscriptAssemblyService } from './transcript-assembly.service';

/**
 * The hand-off boundary with the transcription service (`transcript/`): produces one
 * `transcription` job per recorded answer, consumes the `transcription-events` it
 * sends back, and forwards to the fully-internal `evaluation-processing` queue once
 * the interview's transcript is assembled.
 *
 * Imports entities from `interviews`/`interview-session` directly (not their modules)
 * to avoid a circular dependency — same pattern as `InterviewSessionModule`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Interview, InterviewAnswer, InterviewTranscript]),
    QueueModule,
  ],
  providers: [
    TranscriptionProducerService,
    EvaluationProcessingProducerService,
    TranscriptAssemblyService,
    TranscriptionEventsProcessor,
  ],
  exports: [TranscriptionProducerService, EvaluationProcessingProducerService],
})
export class TranscriptIngestionModule {}
