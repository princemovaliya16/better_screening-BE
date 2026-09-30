import { Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TransformInterceptor } from '@core/dispatchers';
import { CurrentCandidateSession } from './decorators/current-candidate-session.decorator';
import { CandidateInterviewGuard } from './guards/candidate-interview.guard';
import { InterviewSessionService } from './interview-session.service';
import { CandidateSessionContext } from './types/candidate-session-context.type';

/**
 * Candidate portal — no JWT, no account. Auth is entirely the opaque `:token` in the
 * URL, resolved by CandidateInterviewGuard. Every handler acts only on the interview
 * that guard resolves; no interview/candidate id is ever taken from the client.
 *
 * Video goes through LiveKit: the candidate joins a publish-only room, and each
 * question's answer is recorded server-side by Egress (start/stop below) straight
 * into the recordings bucket — nothing is uploaded from the browser.
 */
@ApiTags('Interview session (candidate portal)')
@UseGuards(CandidateInterviewGuard)
@UseInterceptors(TransformInterceptor)
@Controller('interview-session/:token')
export class InterviewSessionController {
  constructor(private readonly interviewSessionService: InterviewSessionService) {}

  @Get()
  getSession(@CurrentCandidateSession() session: CandidateSessionContext) {
    return this.interviewSessionService.getSession(session);
  }

  @Post('livekit/join')
  joinRoom(@CurrentCandidateSession() session: CandidateSessionContext) {
    return this.interviewSessionService.joinRoom(session);
  }

  @Post('questions/:questionId/recording/start')
  startRecording(
    @CurrentCandidateSession() session: CandidateSessionContext,
    @Param('questionId') questionId: string,
  ) {
    return this.interviewSessionService.startRecording(session, questionId);
  }

  @Post('questions/:questionId/recording/stop')
  stopRecording(
    @CurrentCandidateSession() session: CandidateSessionContext,
    @Param('questionId') questionId: string,
  ) {
    return this.interviewSessionService.stopRecording(session, questionId);
  }

  @Post('submit')
  submit(@CurrentCandidateSession() session: CandidateSessionContext) {
    return this.interviewSessionService.submit(session);
  }
}
