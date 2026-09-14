import { BadRequestException, Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import { getEnv } from '@config/env';

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const USERINFO_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

export interface GmailExchangeResult {
  refreshToken: string;
  email: string;
}

export interface SendViaGmailInput {
  refreshToken: string;
  fromEmail: string;
  fromName?: string | null;
  to: string;
  subject: string;
  html: string;
}

/**
 * Thin wrapper over `googleapis` for the one thing we need it for: letting an HR user
 * connect their own Gmail account (OAuth, `gmail.send` scope) so candidate emails go
 * out from their real address instead of the system's shared SMTP sender. Requires a
 * Google Cloud OAuth Client ID/Secret with the Gmail API enabled — see .env.example.
 */
@Injectable()
export class GoogleOAuthService {
  /** True once GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI are actually configured — lets
   * the UI show a real "not set up yet" state instead of a button that 500s. */
  isConfigured(): boolean {
    return !!(
      process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_OAUTH_REDIRECT_URI
    );
  }

  private client() {
    return new google.auth.OAuth2(
      getEnv('GOOGLE_CLIENT_ID'),
      getEnv('GOOGLE_CLIENT_SECRET'),
      getEnv('GOOGLE_OAUTH_REDIRECT_URI'),
    );
  }

  /** `state` should be a short-lived, server-signed token (we use a JwtService-signed
   * one) — Google round-trips it verbatim, and it's our only defense against a forged
   * callback binding tokens to the wrong user (Google's own CSRF `state` contract). */
  getAuthUrl(state: string): string {
    return this.client().generateAuthUrl({
      access_type: 'offline',
      // Forces Google to re-issue a refresh_token even for a user reconnecting after
      // a prior grant — without this, a second consent can come back with none.
      prompt: 'consent',
      scope: [GMAIL_SEND_SCOPE, USERINFO_EMAIL_SCOPE],
      state,
    });
  }

  async exchangeCode(code: string): Promise<GmailExchangeResult> {
    const client = this.client();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new BadRequestException(
        'Google did not return a refresh token. If you previously connected this app, remove its access under your Google Account’s "Third-party access" settings and try connecting again.',
      );
    }
    client.setCredentials(tokens);
    const { data } = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    if (!data.email) throw new BadRequestException('Could not read the connected Gmail address');
    return { refreshToken: tokens.refresh_token, email: data.email };
  }

  /** Sends one email through the connected account's own Gmail — the client
   * auto-refreshes the access token from the stored refresh token as needed. */
  async sendMail({ refreshToken, fromEmail, fromName, to, subject, html }: SendViaGmailInput): Promise<void> {
    const client = this.client();
    client.setCredentials({ refresh_token: refreshToken });
    const gmail = google.gmail({ version: 'v1', auth: client });
    const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
    const raw = buildRawMimeMessage({ from, to, subject, html });
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  }
}

function buildRawMimeMessage({
  from,
  to,
  subject,
  html,
}: {
  from: string;
  to: string;
  subject: string;
  html: string;
}): string {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
  ].join('\r\n');
  return Buffer.from(message).toString('base64url');
}
