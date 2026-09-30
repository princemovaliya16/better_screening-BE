import { Injectable, Logger } from '@nestjs/common';
import { rm } from 'fs/promises';
import { join, resolve } from 'path';
import { getEnv } from '@config/env';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: number | null;
}

/** The subset of the transcription service's `GET /jobs/{externalId}` we use. */
export interface TranscriptionJobResult {
  externalId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  text: string | null;
  language: string | null;
  wordCount: number | null;
  error: string | null;
  segments: TranscriptSegment[];
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Talks to the separately-run transcription service (`transcript/`, see its
 * docs/INTEGRATION.md). Jobs go to it over BullMQ; this covers the other two touch
 * points: the shared audio folder it reads recordings from, and its HTTP API, which
 * is where transcript text is read (completion events carry none).
 */
@Injectable()
export class TranscriptionClientService {
  private readonly logger = new Logger(TranscriptionClientService.name);

  private get apiUrl(): string {
    return getEnv('TRANSCRIPTION_API_URL', 'http://localhost:8000').replace(/\/+$/, '');
  }

  /** Host path of the folder the service mounts as its AUDIO_ROOT. */
  private get audioDir(): string {
    return resolve(getEnv('TRANSCRIPTION_AUDIO_DIR'));
  }

  get language(): string | undefined {
    return getEnv('TRANSCRIPTION_LANGUAGE', '') || undefined;
  }

  /** Where one answer's recording goes: `relativePath` is what the job payload carries
   * (the service resolves it against its AUDIO_ROOT), `absolutePath` is where we write. */
  audioPathFor(
    interviewId: string,
    answerId: string,
  ): { relativePath: string; absolutePath: string } {
    const relativePath = `interviews/${interviewId}/${answerId}.mp4`;
    return { relativePath, absolutePath: join(this.audioDir, relativePath) };
  }

  /** Best-effort clean-up once a job has reached a terminal state. */
  async removeAudio(relativePath: string): Promise<void> {
    try {
      await rm(join(this.audioDir, relativePath), { force: true });
    } catch (err) {
      this.logger.warn(
        `Could not remove ${relativePath}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Returns null if the service has no job with this id. Throws on network/5xx errors
   * so the calling BullMQ job is retried. */
  async getJob(externalId: string): Promise<TranscriptionJobResult | null> {
    const res = await fetch(`${this.apiUrl}/jobs/${encodeURIComponent(externalId)}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Transcription API returned ${res.status} for job ${externalId}`);
    }
    const body = (await res.json()) as Partial<TranscriptionJobResult>;
    return {
      externalId: body.externalId ?? externalId,
      status: body.status ?? 'pending',
      text: body.text ?? null,
      language: body.language ?? null,
      wordCount: body.wordCount ?? null,
      error: body.error ?? null,
      segments: (body.segments ?? []).map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text,
        speaker: s.speaker ?? null,
      })),
    };
  }
}
