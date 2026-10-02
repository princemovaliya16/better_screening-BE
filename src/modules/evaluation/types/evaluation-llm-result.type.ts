import { ScoreDimension } from '../entities/interview-summary.entity';

/** The exact JSON shape we ask the LLM to return — validated in full before anything
 * is persisted (see `EvaluationService.validate`). Each score is 0–100 on its own. */
export interface EvaluationLlmResult {
  scores: Record<ScoreDimension, { score: number; reason: string }>;
  recommendation: 'strong_hire' | 'hire' | 'no_hire' | 'strong_no_hire';
  strengths: string[];
  weaknesses: string[];
  observations: string;
  communicationNote: string;
  perQuestion: {
    questionId: string;
    knowledge: number;
    communication: number;
    relevance: number;
    feedback: string;
  }[];
}
