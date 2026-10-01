import type { TranscriptSegment } from '@core/transcription';

/** A gap between two utterances at least this long counts as a long pause. */
export const LONG_PAUSE_SECONDS = 2;

/** Measured delivery for one answer (or, aggregated, for the whole interview) —
 * computed from the transcription service's timed utterances, not judged by the AI.
 * Feeds the Communication & Confidence scores as facts and is shown to recruiters. */
export interface SpeechMetricsValues {
  wordCount: number;
  /** Total time spent actually speaking (sum of utterance durations). */
  speakingSeconds: number;
  recordingSeconds: number | null;
  /** Words per speaking minute; null when there's too little speech to measure. */
  wordsPerMinute: number | null;
  /** speakingSeconds / recordingSeconds, 0–1; null without a recording length. */
  talkRatio: number | null;
  longPauses: number;
  /** Silence before the first word (averaged over answered questions in the aggregate). */
  responseDelaySeconds: number | null;
}

export interface SpeechMetrics {
  overall: SpeechMetricsValues;
  perQuestion: Record<string, SpeechMetricsValues>;
}

export interface SpeechMetricsInput {
  questionId: string;
  transcriptText: string | null | undefined;
  segments: TranscriptSegment[] | null | undefined;
  recordingSeconds: number | null | undefined;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function countWords(text: string | null | undefined): number {
  return (text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

/** Below a few seconds of speech, words-per-minute is noise rather than a pace. */
function wordsPerMinute(words: number, speakingSeconds: number): number | null {
  return speakingSeconds >= 3 && words > 0 ? Math.round(words / (speakingSeconds / 60)) : null;
}

function talkRatio(speakingSeconds: number, recordingSeconds: number | null): number | null {
  if (!recordingSeconds || recordingSeconds <= 0) return null;
  return round2(Math.min(1, speakingSeconds / recordingSeconds));
}

export function computeAnswerSpeechMetrics(input: SpeechMetricsInput): SpeechMetricsValues {
  const segments = [...(input.segments ?? [])]
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start)
    .sort((a, b) => a.start - b.start);
  const wordCount = countWords(input.transcriptText);
  const recordingSeconds = input.recordingSeconds ?? null;
  const speakingSeconds = round1(segments.reduce((sum, s) => sum + (s.end - s.start), 0));

  let longPauses = 0;
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start - segments[i - 1].end >= LONG_PAUSE_SECONDS) longPauses++;
  }

  return {
    wordCount,
    speakingSeconds,
    recordingSeconds,
    wordsPerMinute: wordsPerMinute(wordCount, speakingSeconds),
    talkRatio: talkRatio(speakingSeconds, recordingSeconds),
    longPauses,
    responseDelaySeconds: segments.length > 0 ? round1(segments[0].start) : null,
  };
}

export function computeSpeechMetrics(inputs: SpeechMetricsInput[]): SpeechMetrics {
  const perQuestion: Record<string, SpeechMetricsValues> = {};
  for (const input of inputs) perQuestion[input.questionId] = computeAnswerSpeechMetrics(input);

  const answers = Object.values(perQuestion);
  const spoken = answers.filter((a) => a.wordCount > 0);
  const wordCount = answers.reduce((sum, a) => sum + a.wordCount, 0);
  const speakingSeconds = round1(answers.reduce((sum, a) => sum + a.speakingSeconds, 0));
  const withLength = answers.filter((a) => a.recordingSeconds);
  const recordingSeconds = withLength.length
    ? withLength.reduce((sum, a) => sum + (a.recordingSeconds ?? 0), 0)
    : null;
  const delays = spoken.map((a) => a.responseDelaySeconds).filter((d): d is number => d != null);

  return {
    perQuestion,
    overall: {
      wordCount,
      speakingSeconds,
      recordingSeconds,
      wordsPerMinute: wordsPerMinute(wordCount, speakingSeconds),
      talkRatio: talkRatio(speakingSeconds, recordingSeconds),
      longPauses: answers.reduce((sum, a) => sum + a.longPauses, 0),
      responseDelaySeconds: delays.length
        ? round1(delays.reduce((sum, d) => sum + d, 0) / delays.length)
        : null,
    },
  };
}
