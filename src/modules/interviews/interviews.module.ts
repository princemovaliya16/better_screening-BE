import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityModule } from '@module/activity';
import { CandidatesModule } from '@module/candidates/candidates.module';
import { Candidate } from '@module/candidates/entities';
import { InterviewSessionModule } from '@module/interview-session';
import { JobsModule } from '@module/jobs/jobs.module';
import { MailAccountsModule } from '@module/mail-accounts';
import { NotificationsModule } from '@module/notifications';
import { OrganizationSettings } from '@module/organizations/entities';
import { TranscriptIngestionModule } from '@module/transcript-ingestion';
import { InterviewQuestion, Interview } from './entities';
import { InterviewsController } from './interviews.controller';
import { InterviewsService } from './interviews.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Interview, InterviewQuestion, Candidate, OrganizationSettings]),
    JobsModule,
    CandidatesModule,
    InterviewSessionModule,
    TranscriptIngestionModule,
    MailAccountsModule,
    NotificationsModule,
    ActivityModule,
  ],
  controllers: [InterviewsController],
  providers: [InterviewsService],
  exports: [InterviewsService],
})
export class InterviewsModule {}
