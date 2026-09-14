import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { decryptSecret, encryptSecret } from '@core/utils/crypt.util';
import { GoogleOAuthService } from '@core/google';
import { MailService } from '@core/mail';
import { UpdateSignatureDto } from './dto';
import { UserMailSettings } from './entities';

export interface MailAccountStatus {
  signatureName: string | null;
  signatureDesignation: string | null;
  signatureCompany: string | null;
  signaturePhone: string | null;
  signatureWebsite: string | null;
  gmailConnected: boolean;
  gmailEmail: string | null;
  gmailConnectedAt: Date | null;
  /** Whether the server even has a Google OAuth client configured — lets the UI show
   * a real "not set up" state instead of a button that fails on click. */
  googleConfigured: boolean;
}

interface OAuthState {
  uid: string;
  organizationId: string;
  purpose: 'gmail-connect';
}

/**
 * Owns "how does this HR user's outgoing candidate mail look and where does it come
 * from" — the email signature (any sender) and an optional connected Gmail account
 * (gmail.send scope) that, once connected, becomes the real sender for every
 * candidate email this user triggers instead of the shared system SMTP address.
 */
@Injectable()
export class MailAccountsService {
  constructor(
    @InjectRepository(UserMailSettings)
    private readonly repository: Repository<UserMailSettings>,
    private readonly jwtService: JwtService,
    private readonly googleOAuth: GoogleOAuthService,
    private readonly mailService: MailService,
  ) {}

  private async getOrCreate(userId: string, organizationId: string): Promise<UserMailSettings> {
    const existing = await this.repository.findOne({ where: { userId } });
    if (existing) return existing;
    return this.repository.save(this.repository.create({ userId, organizationId }));
  }

  async getStatus(userId: string, organizationId: string): Promise<MailAccountStatus> {
    const row = await this.getOrCreate(userId, organizationId);
    return {
      signatureName: row.signatureName ?? null,
      signatureDesignation: row.signatureDesignation ?? null,
      signatureCompany: row.signatureCompany ?? null,
      signaturePhone: row.signaturePhone ?? null,
      signatureWebsite: row.signatureWebsite ?? null,
      gmailConnected: !!row.gmailEmail,
      gmailEmail: row.gmailEmail ?? null,
      gmailConnectedAt: row.gmailConnectedAt ?? null,
      googleConfigured: this.googleOAuth.isConfigured(),
    };
  }

  async updateSignature(
    userId: string,
    organizationId: string,
    dto: UpdateSignatureDto,
  ): Promise<MailAccountStatus> {
    const row = await this.getOrCreate(userId, organizationId);
    Object.assign(row, dto);
    await this.repository.save(row);
    return this.getStatus(userId, organizationId);
  }

  /** Short-lived, server-signed `state` — Google round-trips it verbatim to the
   * callback, which has no Authorization header (the browser navigated there
   * directly), so this is how the callback knows which user to attach tokens to. */
  getGmailConnectUrl(userId: string, organizationId: string): string {
    if (!this.googleOAuth.isConfigured()) {
      throw new BadRequestException(
        'Gmail integration is not configured on this server yet (missing GOOGLE_CLIENT_ID/SECRET).',
      );
    }
    const state = this.jwtService.sign(
      { uid: userId, organizationId, purpose: 'gmail-connect' } satisfies OAuthState,
      { expiresIn: '10m' },
    );
    return this.googleOAuth.getAuthUrl(state);
  }

  async handleGmailCallback(code: string, state: string): Promise<{ organizationId: string }> {
    let payload: OAuthState;
    try {
      payload = this.jwtService.verify<OAuthState>(state);
    } catch {
      throw new UnauthorizedException('This Gmail connection link has expired — try connecting again.');
    }
    if (payload.purpose !== 'gmail-connect') throw new UnauthorizedException('Invalid state');

    const { refreshToken, email } = await this.googleOAuth.exchangeCode(code);
    const row = await this.getOrCreate(payload.uid, payload.organizationId);
    row.gmailEmail = email;
    row.gmailRefreshTokenEnc = encryptSecret(refreshToken);
    row.gmailConnectedAt = new Date();
    await this.repository.save(row);
    return { organizationId: payload.organizationId };
  }

  async disconnectGmail(userId: string, organizationId: string): Promise<void> {
    await this.repository.update(
      { userId, organizationId },
      { gmailEmail: null, gmailRefreshTokenEnc: null, gmailConnectedAt: null },
    );
  }

  private buildSignatureHtml(row: UserMailSettings): string {
    if (!row.signatureName) return '';
    const lines = [row.signatureName];
    const role = [row.signatureDesignation, row.signatureCompany].filter(Boolean).join(', ');
    if (role) lines.push(role);
    const contact = [row.signaturePhone, row.signatureWebsite].filter(Boolean).join(' &middot; ');
    if (contact) lines.push(contact);
    return `<p>Best regards,<br>${lines.join('<br>')}</p>`;
  }

  /**
   * The single seam every candidate-facing email should go through from here on
   * (interview invitations, the email composer's "send") instead of calling
   * `MailService` directly — appends the sending user's signature, and if they've
   * connected Gmail, sends from their real address via the Gmail API instead of the
   * shared system SMTP sender.
   */
  async sendCandidateEmail(
    sentByUserId: string,
    organizationId: string,
    { to, subject, html }: { to: string; subject: string; html: string },
  ): Promise<void> {
    const row = await this.repository.findOne({
      where: { userId: sentByUserId, organizationId },
      select: {
        id: true,
        signatureName: true,
        signatureDesignation: true,
        signatureCompany: true,
        signaturePhone: true,
        signatureWebsite: true,
        gmailEmail: true,
        gmailRefreshTokenEnc: true,
      },
    });
    const finalHtml = row ? html + this.buildSignatureHtml(row) : html;

    if (row?.gmailEmail && row.gmailRefreshTokenEnc) {
      await this.googleOAuth.sendMail({
        refreshToken: decryptSecret(row.gmailRefreshTokenEnc),
        fromEmail: row.gmailEmail,
        fromName: row.signatureName,
        to,
        subject,
        html: finalHtml,
      });
      return;
    }
    await this.mailService.sendMail({ to, subject, html: finalHtml });
  }
}
