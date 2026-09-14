import { Column, Entity, Index, JoinColumn, OneToOne } from 'typeorm';
import { AppBaseEntity } from '@core/database';
import { Organization } from './organization.entity';

export enum EmailTone {
  PROFESSIONAL = 'professional',
  FRIENDLY = 'friendly',
  CONCISE = 'concise',
  WARM = 'warm',
}

@Entity('organization_settings')
export class OrganizationSettings extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  organizationId!: string;

  @OneToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization?: Organization;

  @Column({ default: true })
  aiInterviewEnabled!: boolean;

  @Column({ default: 30 })
  defaultRoundDurationMinutes!: number;

  @Column({ default: 'Asia/Kolkata (IST)' })
  defaultTimezone!: string;

  @Column({ default: true })
  notifyOnEvaluationReady!: boolean;

  @Column({ default: true })
  notifyOnNewApplication!: boolean;

  @Column({ default: true })
  notifyOnInterviewScheduled!: boolean;

  @Column({ default: true })
  notifyOnRoundDecision!: boolean;

  /** No digest-sending job consumes this yet — saved for when a weekly-hiring-digest
   * email job is built. */
  @Column({ default: false })
  weeklyDigestEnabled!: boolean;

  /** No product-announcements system exists yet — saved for when one is built. */
  @Column({ default: false })
  productUpdatesEnabled!: boolean;

  @Column({ default: true })
  aiQuestionGenEnabled!: boolean;

  @Column({ default: true })
  aiResumeParseEnabled!: boolean;

  /** No kill switch wired yet in the evaluation pipeline — saved for when one is
   * added there. */
  @Column({ default: true })
  aiScoringEnabled!: boolean;

  /** No kill switch wired yet in the evaluation pipeline — saved for when one is
   * added there. */
  @Column({ default: true })
  aiSummaryEnabled!: boolean;

  @Column({ default: true })
  aiEmailDraftingEnabled!: boolean;

  @Column({ type: 'enum', enum: EmailTone, default: EmailTone.PROFESSIONAL })
  emailTone!: EmailTone;

  @Column({ type: 'text', nullable: true })
  emailSignature?: string | null;
}
