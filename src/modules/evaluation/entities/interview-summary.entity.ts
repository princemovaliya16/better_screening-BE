import { Column, Entity, Index } from 'typeorm';
import { OrgScopedEntity } from '@core/database';
import type { SpeechMetrics } from '../speech-metrics';

export enum EvaluationRecommendation {
  STRONG_HIRE = 'strong_hire',
  HIRE = 'hire',
  NO_HIRE = 'no_hire',
  STRONG_NO_HIRE = 'strong_no_hire',
}

/** The six analysis categories, each scored independently 0–100 (they don't add up
 * to 100). The overall score is their plain average. */
export const SCORE_DIMENSIONS = [
  'knowledge',
  'communication',
  'relevance',
  'jobFit',
  'problemSolving',
  'confidence',
] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

/** Category key → 0–100. Keyed loosely because evaluations stored before the six
 * categories (technicalSkills, culturalFit, …) keep their original keys. */
export type CompetencyScores = Record<string, number>;

/** One row per interview — the persisted result of our own `EvaluationModule`
 * running the resume × job description × transcript analysis. Never written by the
 * STT vendor; this is entirely our backend's LLM call. */
@Entity('interview_summaries')
export class InterviewSummary extends OrgScopedEntity {
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  interviewId!: string;

  @Column({ type: 'numeric' })
  overallScore!: number;

  @Column({ type: 'enum', enum: EvaluationRecommendation })
  recommendation!: EvaluationRecommendation;

  @Column({ type: 'jsonb' })
  strengths!: string[];

  @Column({ type: 'jsonb' })
  weaknesses!: string[];

  @Column({ type: 'text' })
  observations!: string;

  @Column({ type: 'text' })
  communicationNote!: string;

  @Column({ type: 'jsonb' })
  competencyScores!: CompetencyScores;

  /** One-sentence justification per category (same keys as competencyScores). */
  @Column({ type: 'jsonb', nullable: true })
  scoreReasons?: Record<string, string> | null;

  /** Measured delivery (pace, talk time, pauses) computed from the transcript timings. */
  @Column({ type: 'jsonb', nullable: true })
  speechMetrics?: SpeechMetrics | null;

  /** The LLM's full structured response, kept verbatim for audit/debugging —
   * separate from the normalized columns above. */
  @Column({ type: 'jsonb' })
  rawLlmResponse!: unknown;
}
