import { Column, Entity, Index, Unique } from 'typeorm';
import { OrgScopedEntity } from '@core/database';

export interface QuestionDimensionScores {
  knowledge: number;
  communication: number;
  relevance: number;
}

/** One row per question — the LLM's per-question score/feedback, keyed off the
 * frozen `interview_questions` snapshot (not the round template). */
@Entity('interview_question_analyses')
@Unique(['interviewId', 'interviewQuestionId'])
export class InterviewQuestionAnalysis extends OrgScopedEntity {
  @Index()
  @Column({ type: 'uuid' })
  interviewId!: string;

  @Column({ type: 'uuid' })
  interviewQuestionId!: string;

  @Column({ type: 'numeric' })
  score!: number;

  @Column({ type: 'text' })
  feedback!: string;

  /** Per-question breakdown, 0–100 each; `score` is their average. */
  @Column({ type: 'jsonb', nullable: true })
  dimensionScores?: QuestionDimensionScores | null;
}
