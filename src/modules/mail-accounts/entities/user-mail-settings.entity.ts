import { Column, Entity, Index } from 'typeorm';
import { AppBaseEntity } from '@core/database';

/**
 * Per-user "how do my outgoing candidate emails look and where do they come from"
 * settings — one row per user, created lazily on first read/write (no natural
 * creation point analogous to org signup, since it applies to every user account).
 *
 * The Gmail refresh token is the only long-lived OAuth credential we keep (access
 * tokens are short-lived and re-minted per send via googleapis) and is encrypted at
 * rest with `encryptSecret`/`decryptSecret` — see @core/utils/crypt.util. `select:
 * false` keeps it out of any plain `find()`/`findOne()` result; callers that need to
 * actually send mail must opt in explicitly.
 */
@Entity('user_mail_settings')
export class UserMailSettings extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  userId!: string;

  @Index()
  @Column({ type: 'uuid' })
  organizationId!: string;

  @Column({ type: 'varchar', nullable: true })
  signatureName?: string | null;

  @Column({ type: 'varchar', nullable: true })
  signatureDesignation?: string | null;

  @Column({ type: 'varchar', nullable: true })
  signatureCompany?: string | null;

  @Column({ type: 'varchar', nullable: true })
  signaturePhone?: string | null;

  @Column({ type: 'varchar', nullable: true })
  signatureWebsite?: string | null;

  @Column({ type: 'varchar', nullable: true })
  gmailEmail?: string | null;

  @Column({ type: 'text', nullable: true, select: false })
  gmailRefreshTokenEnc?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  gmailConnectedAt?: Date | null;
}
