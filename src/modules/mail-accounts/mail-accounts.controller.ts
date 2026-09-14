import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { getEnv } from '@config/env';
import { TransformInterceptor } from '@core/dispatchers';
import { CurrentOrgUser } from '@module/auth/decorators';
import { OrgAuthGuard } from '@module/auth/guards';
import { AuthenticatedOrgUser } from '@module/auth/types/jwt-payload.type';
import { UpdateSignatureDto } from './dto';
import { MailAccountsService } from './mail-accounts.service';

@ApiTags('Mail accounts')
@Controller('mail-accounts')
export class MailAccountsController {
  constructor(private readonly mailAccountsService: MailAccountsService) {}

  @ApiBearerAuth()
  @UseGuards(OrgAuthGuard)
  @UseInterceptors(TransformInterceptor)
  @Get('status')
  getStatus(@CurrentOrgUser() user: AuthenticatedOrgUser) {
    return this.mailAccountsService.getStatus(user.uid, user.organizationId);
  }

  @ApiBearerAuth()
  @UseGuards(OrgAuthGuard)
  @UseInterceptors(TransformInterceptor)
  @Patch('signature')
  updateSignature(@CurrentOrgUser() user: AuthenticatedOrgUser, @Body() dto: UpdateSignatureDto) {
    return this.mailAccountsService.updateSignature(user.uid, user.organizationId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(OrgAuthGuard)
  @UseInterceptors(TransformInterceptor)
  @Get('gmail/connect-url')
  getGmailConnectUrl(@CurrentOrgUser() user: AuthenticatedOrgUser) {
    return { url: this.mailAccountsService.getGmailConnectUrl(user.uid, user.organizationId) };
  }

  @ApiBearerAuth()
  @UseGuards(OrgAuthGuard)
  @UseInterceptors(TransformInterceptor)
  @Delete('gmail')
  disconnectGmail(@CurrentOrgUser() user: AuthenticatedOrgUser) {
    return this.mailAccountsService.disconnectGmail(user.uid, user.organizationId);
  }

  /**
   * Google redirects the candidate's/recruiter's *browser* here directly after
   * consent — no Authorization header is available, which is exactly why
   * `getGmailConnectUrl` embeds a signed `state` instead of relying on a guard.
   * Not part of the JSON API: ends in a plain HTTP redirect back to the app.
   */
  @ApiExcludeEndpoint()
  @Get('gmail/callback')
  async gmailCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    const frontendUrl = getEnv('FRONTEND_URL', 'http://localhost:5173');
    const settingsUrl = `${frontendUrl}/app/settings?tab=email`;
    if (error || !code || !state) {
      res.redirect(`${settingsUrl}&gmail=error&reason=${encodeURIComponent(error ?? 'missing_code')}`);
      return;
    }
    try {
      await this.mailAccountsService.handleGmailCallback(code, state);
      res.redirect(`${settingsUrl}&gmail=connected`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown_error';
      res.redirect(`${settingsUrl}&gmail=error&reason=${encodeURIComponent(reason)}`);
    }
  }
}
