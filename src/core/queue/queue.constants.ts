/**
 * Queue names.
 * TRANSCRIPTION: we produce, the transcription service (`transcript/`, Python + Deepgram)
 *   consumes — one job per recorded answer, audio passed by path on a shared folder.
 * TRANSCRIPTION_EVENTS: the transcription service produces `transcription.completed` /
 *   `transcription.failed` (no text — we fetch it from its HTTP API), we consume.
 * EVALUATION_PROCESSING: fully internal — our own producer/consumer, runs our LLM-based
 *   evaluation (resume × JD × transcript). The transcription service never touches it.
 *
 * All use BullMQ's default `bull` key prefix, which must match the transcription
 * service's REDIS_PREFIX.
 */
export const QUEUE_NAMES = {
  TRANSCRIPTION: 'transcription',
  TRANSCRIPTION_EVENTS: 'transcription-events',
  EVALUATION_PROCESSING: 'evaluation-processing',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
