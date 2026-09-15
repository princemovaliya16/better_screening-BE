/** A best-effort extraction. The recruiter reviews/edits these values in the Add
 * Candidate form before submitting the normal create endpoint — which carries
 * `resumePath`/`resumeText` straight through so the stored file stays attached to
 * the candidate it was parsed for. */
export interface ParsedResumeInfo {
  name?: string;
  email?: string;
  phone?: string;
  experienceYears?: number;
  currentCompany?: string;
  location?: string;
  education?: string;
  skills?: string[];
  /** Storage key of the uploaded file, to be passed back to `create()`. Absent if
   * the upload failed — parsing still succeeds in that case. */
  resumePath?: string;
  /** Plain text extracted from the file, to be passed back to `create()`. */
  resumeText?: string;
}
