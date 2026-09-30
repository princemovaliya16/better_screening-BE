/**
 * Cross-module BullMQ job payload contracts — see the queue contract in the
 * implementation plan (§2.5). These are shared by producers/consumers on both sides
 * of a queue, so they live in `core/queue` rather than inside any one feature module.
 */

/** We produce this, one per recorded answer; the transcription service consumes it
 * (contract: transcript/docs/INTEGRATION.md). `id` is our answer id — also the dedupe
 * key and the `externalId` echoed back in events. `audioPath` is relative to the
 * shared audio folder (the service's AUDIO_ROOT); URLs are not accepted. */
export interface TranscriptionJobPayload {
  id: string;
  audioPath: string;
  language?: string;
  metadata: {
    interviewId: string;
    answerId: string;
    questionId: string;
    organizationId: string;
  };
}

/** The transcription service publishes this once a job reaches a terminal state
 * (`transcription.failed` only after its final attempt). It carries no transcript
 * text — that is read from the service's `GET /jobs/{externalId}`. */
export interface TranscriptionEventPayload {
  event: 'transcription.completed' | 'transcription.failed';
  externalId: string;
  status?: string;
  error?: string;
  wordCount?: number;
  durationSeconds?: number;
  skipped?: boolean;
}

/** Fully internal — our own producer, our own consumer. The STT vendor never sees
 * this queue. Deliberately minimal: the EvaluationModule consumer loads everything
 * else itself from Postgres (job/resume/transcript/questions) keyed off these ids. */
export interface EvaluationProcessingJobPayload {
  interviewId: string;
  candidateId: string;
  organizationId: string;
}
