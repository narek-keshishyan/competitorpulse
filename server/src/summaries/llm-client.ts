import { z } from 'zod';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmClient {
  readonly model: string;
  complete(messages: ChatMessage[]): Promise<string>;
}

export class LlmError extends Error {
  override name = 'LlmError';

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

export interface OpenAiCompatibleClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens?: number;
}

/**
 * Minimal client for the OpenAI Chat Completions API. Plain `fetch` instead of an SDK:
 * we need one endpoint, and owning the timeout and the retryable/permanent error split
 * matters more here than SDK conveniences. Works with OpenAI, any OpenAI-compatible
 * provider, Ollama, and the bundled mock server.
 */
export class OpenAiCompatibleClient implements LlmClient {
  readonly model: string;
  private readonly url: string;

  constructor(private readonly options: OpenAiCompatibleClientOptions) {
    this.model = options.model;
    this.url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          messages,
          temperature: 0.2,
          max_tokens: this.options.maxTokens ?? 200,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new LlmError(`LLM request timed out after ${this.options.timeoutMs}ms`, true);
      }
      throw new LlmError(`LLM request failed: ${(err as Error).message}`, true);
    }

    if (!response.ok) {
      // 408/429 and 5xx are worth retrying; other 4xx (bad key, unknown model, bad
      // request) will fail the same way every time.
      const retryable =
        response.status === 408 || response.status === 429 || response.status >= 500;
      const detail = await response.text().catch(() => '');
      throw new LlmError(
        `LLM answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        retryable,
        response.status,
      );
    }

    const parsed = completionSchema.safeParse(await response.json().catch(() => null));
    const content = parsed.success ? parsed.data.choices[0]?.message.content?.trim() : undefined;
    if (!content) {
      throw new LlmError('LLM response had no message content', true);
    }
    return content;
  }
}
