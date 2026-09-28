import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { LivekitService } from '@core/livekit';
import { InterviewSessionService } from './interview-session.service';

/**
 * LiveKit server → us. Public route, authenticated by the signed `Authorization`
 * header LiveKit sends (verified against the raw body — see the express.raw()
 * registration for this path in main.ts). Not wrapped in the response envelope:
 * LiveKit only cares about the status code.
 */
@ApiExcludeController()
@Controller('livekit/webhook')
export class LivekitWebhookController {
  private readonly logger = new Logger(LivekitWebhookController.name);

  constructor(
    private readonly livekitService: LivekitService,
    private readonly interviewSessionService: InterviewSessionService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: Request,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<void> {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    let event;
    try {
      event = await this.livekitService.receiveWebhook(rawBody, authorization);
    } catch {
      throw new UnauthorizedException('Invalid LiveKit webhook signature');
    }
    this.logger.debug(`LiveKit webhook: ${event.event} ${event.egressInfo?.egressId ?? ''}`);
    await this.interviewSessionService.handleLivekitWebhook(event);
  }
}
