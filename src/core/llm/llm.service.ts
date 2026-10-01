import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '@config/env';

const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TIMEOUT_MS = 120_000;

export interface LlmJsonCompletionParams {
  /** System prompt — task framing, output-format instructions. */
  system: string;
  /** The user-turn prompt — the actual data (resume/JD/transcript/etc). */
  prompt: string;
  maxTokens?: number;
}

/**
 * Thin, generic "call the LLM with a prompt, get structured JSON back" wrapper —
 * config-driven provider so it's swappable (`LLM_PROVIDER`/`LLM_API_KEY`/`LLM_MODEL`
 * in env). Every call site (question generation, email drafting, interview evaluation)
 * goes through `completeJson`.
 *
 * `LLM_PROVIDER=mock` (no API key needed) makes every call site return its own
 * deterministic canned response instead of calling out to a real model — useful for
 * local development and for exercising the rest of the pipeline (prompt building,
 * response validation, persistence, BullMQ retry/idempotency) without depending on a
 * live key. `LLM_PROVIDER=groq` (e.g. `LLM_MODEL=openai/gpt-oss-120b`) and
 * `LLM_PROVIDER=anthropic` (the default) make real calls.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private anthropicClient?: Anthropic;

  private apiKey(): string {
    const apiKey = getEnv('LLM_API_KEY', '');
    if (!apiKey) {
      throw new Error(
        'LLM_API_KEY is not set. Set it in .env to make real LLM calls, or set ' +
          'LLM_PROVIDER=mock for local development without one.',
      );
    }
    return apiKey;
  }

  private getAnthropic(): Anthropic {
    this.anthropicClient ??= new Anthropic({ apiKey: this.apiKey() });
    return this.anthropicClient;
  }

  /**
   * @param mock Deterministic canned response for this call site, used only when
   *   `LLM_PROVIDER=mock`. Each caller supplies its own — a generic mock couldn't
   *   produce data shaped like a real question list vs. a real evaluation result.
   */
  async completeJson<T>(params: LlmJsonCompletionParams, mock: () => T): Promise<T> {
    const provider = getEnv('LLM_PROVIDER', 'anthropic');
    if (provider === 'mock') {
      this.logger.warn('LLM_PROVIDER=mock — returning a canned response, not calling a real LLM');
      return mock();
    }
    if (provider === 'groq') return this.completeJsonGroq<T>(params);
    if (provider !== 'anthropic') {
      throw new Error(`Unsupported LLM_PROVIDER "${provider}" — use groq, anthropic or mock.`);
    }

    const client = this.getAnthropic();
    const model = getEnv('LLM_MODEL', 'claude-sonnet-5');
    const response = await client.messages.create({
      model,
      max_tokens: params.maxTokens ?? 4096,
      system: params.system,
      messages: [{ role: 'user', content: params.prompt }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    return this.parseJson<T>(text);
  }

  /**
   * Groq's OpenAI-compatible chat completions API. JSON mode guarantees a
   * syntactically valid JSON object (callers still validate its shape); a low
   * temperature keeps scoring consistent between runs. Reasoning models such as
   * gpt-oss spend part of the token budget thinking, so the budget is generous.
   */
  private async completeJsonGroq<T>(params: LlmJsonCompletionParams): Promise<T> {
    const body = {
      model: getEnv('LLM_MODEL', 'openai/gpt-oss-120b'),
      max_completion_tokens: Math.max(params.maxTokens ?? 4096, 8192),
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.prompt },
      ],
    };
    const res = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500);
      throw new Error(`Groq API returned ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as {
      choices?: { finish_reason?: string; message?: { content?: string | null } }[];
    };
    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') {
      throw new Error(
        'LLM response was cut off (token limit reached) before the JSON was complete',
      );
    }
    return this.parseJson<T>(choice?.message?.content ?? '');
  }

  private parseJson<T>(text: string): T {
    // Models often wrap JSON in a ```json fence even when asked not to — strip it.
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    try {
      return JSON.parse(cleaned) as T;
    } catch (err) {
      throw new Error(
        `LLM response was not valid JSON (${(err as Error).message}):\n${text.slice(0, 2000)}`,
      );
    }
  }
}
