/** A best-effort extraction only — not persisted. The recruiter reviews/edits these
 * values in the Add Candidate form before submitting the normal create endpoint. */
export interface ParsedResumeInfo {
  name?: string;
  email?: string;
  phone?: string;
  experienceYears?: number;
  currentCompany?: string;
  location?: string;
  education?: string;
  skills?: string[];
}
