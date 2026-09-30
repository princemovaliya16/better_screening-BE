import { Column, Entity, Index } from 'typeorm';
import { OrgScopedEntity } from '@core/database';

/** One row per interview — assembled from the per-answer results of the transcription
 * service once every answer is done (TranscriptAssemblyService). `perQuestion` is a jsonb array rather than a child table since it's always read
 * and written as a whole alongside `combinedText`, never queried per-row. */
@Entity('interview_transcripts')
export class InterviewTranscript extends OrgScopedEntity {
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  interviewId!: string;

  @Column({ type: 'text' })
  combinedText!: string;

  @Column({ type: 'jsonb' })
  perQuestion!: { questionId: string; transcriptText: string }[];

  @Column({ type: 'varchar', nullable: true })
  language?: string | null;

  /** Set instead of a transcript when no answer could be transcribed — kept so the row
   * is still created idempotently and the failure is visible for triage. */
  @Column({ type: 'text', nullable: true })
  failureReason?: string | null;
}
