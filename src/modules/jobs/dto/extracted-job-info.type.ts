import { EmploymentType } from '../entities';

/** A suggestion only — not persisted. The recruiter reviews/edits these values in
 * the Create Job form before submitting the normal create endpoint. */
export interface ExtractedJobSkill {
  name: string;
}

export interface ExtractedJobInfo {
  title?: string;
  department?: string;
  location?: string;
  employmentType?: EmploymentType;
  experienceMin?: number;
  experienceMax?: number;
  positionsCount?: number;
  description?: string;
  skills?: ExtractedJobSkill[];
}
