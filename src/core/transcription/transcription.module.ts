import { Global, Module } from '@nestjs/common';
import { TranscriptionClientService } from './transcription-client.service';

@Global()
@Module({
  providers: [TranscriptionClientService],
  exports: [TranscriptionClientService],
})
export class TranscriptionModule {}
