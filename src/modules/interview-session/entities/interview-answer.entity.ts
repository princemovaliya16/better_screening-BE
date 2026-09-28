import { Column, Entity, Index, Unique } from 'typeorm';
import { AppBaseEntity } from '@core/database';

export enum InterviewAnswerStatus {
  /** LiveKit Egress is currently recording this question. */
  RECORDING = 'recording',
  /** Egress stopped; waiting for the `egress_ended` webhook to confirm the file. */
  PROCESSING = 'processing',
  /** Egress failed/aborted — the candidate can re-record this question. */
  FAILED = 'failed',
  UPLOADED = 'uploaded',
  TRANSCRIBED = 'transcribed',
  SCORED = 'scored',
}

/** One row per question — the candidate's raw recording, written by LiveKit Egress
 * straight into the recordings bucket. RECORDING → PROCESSING → UPLOADED (or FAILED)
 * is driven by this module; TRANSCRIBED/SCORED by the later AI pipeline. */
@Entity('interview_answers')
@Unique(['interviewId', 'interviewQuestionId'])
export class InterviewAnswer extends AppBaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  interviewId!: string;

  @Column({ type: 'uuid' })
  interviewQuestionId!: string;

  @Index()
  @Column({ type: 'uuid' })
  organizationId!: string;

  @Column()
  recordingStoragePath!: string;

  @Column()
  recordingMimeType!: string;

  @Column({ type: 'int', nullable: true })
  recordingDurationSeconds?: number | null;

  @Column({ type: 'int', nullable: true })
  recordingSizeBytes?: number | null;

  @Column({ type: 'enum', enum: InterviewAnswerStatus, default: InterviewAnswerStatus.UPLOADED })
  status!: InterviewAnswerStatus;

  @Index({ unique: true })
  @Column({ type: 'varchar', nullable: true })
  egressId?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  recordingStartedAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  recordingEndedAt?: Date | null;

  @Column({ type: 'text', nullable: true })
  failureReason?: string | null;
}

/** Statuses that mean "this question has a usable recording" (or will, once the
 * egress_ended webhook lands) — i.e. the candidate shouldn't be asked to redo it. */
export const ANSWERED_STATUSES: InterviewAnswerStatus[] = [
  InterviewAnswerStatus.PROCESSING,
  InterviewAnswerStatus.UPLOADED,
  InterviewAnswerStatus.TRANSCRIBED,
  InterviewAnswerStatus.SCORED,
];

/** Statuses with a finished file in storage — safe to transcribe or play back. */
export const PLAYABLE_STATUSES: InterviewAnswerStatus[] = [
  InterviewAnswerStatus.UPLOADED,
  InterviewAnswerStatus.TRANSCRIBED,
  InterviewAnswerStatus.SCORED,
];
