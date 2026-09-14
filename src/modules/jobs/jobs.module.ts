import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityModule } from '@module/activity';
import { Candidate } from '@module/candidates/entities';
import { InterviewRoundQuestion, InterviewRoundTemplate, Job, JobSkill } from './entities';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Job,
      JobSkill,
      InterviewRoundTemplate,
      InterviewRoundQuestion,
      Candidate,
    ]),
    ActivityModule,
  ],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
