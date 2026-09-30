import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Interview, InterviewQuestion } from '@module/interviews/entities';
import { InterviewTranscript, TranscriptIngestionModule } from '@module/transcript-ingestion';
import { InterviewAccessToken, InterviewAnswer } from './entities';
import { CandidateInterviewGuard } from './guards/candidate-interview.guard';
import { InterviewSessionController } from './interview-session.controller';
import { InterviewSessionService } from './interview-session.service';
import { LivekitWebhookController } from './livekit-webhook.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Interview,
      InterviewQuestion,
      InterviewAccessToken,
      InterviewAnswer,
      InterviewTranscript,
    ]),
    TranscriptIngestionModule,
  ],
  controllers: [InterviewSessionController, LivekitWebhookController],
  providers: [InterviewSessionService, CandidateInterviewGuard],
  exports: [InterviewSessionService],
})
export class InterviewSessionModule {}
