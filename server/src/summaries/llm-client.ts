import OpenAI from 'openai';

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

export interface OpenAiCompatibleClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens?: number;
}

/**
 * Chat Completions client built on the official `openai` SDK. Pointing `baseUrl` elsewhere
 * makes it work with any OpenAI-compatible endpoint: OpenAI, Anthropic's compatibility
 * endpoint, Ollama, or the bundled mock server.
 *
 * The SDK's own retries are disabled: the summary worker owns retrying (with backoff,
 * attempt counting and fencing in the database), so one attempt is exactly one billed
 * request. This class only maps SDK errors to retryable or permanent failures.
 */
export class OpenAiCompatibleClient implements LlmClient {
  readonly model: string;
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAiCompatibleClientOptions) {
    this.model = options.model;
    this.client = new OpenAI({
      baseURL: options.baseUrl,
      apiKey: options.apiKey,
      timeout: options.timeoutMs,
      maxRetries: 0,
    });
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create({
        model: this.options.model,
        messages,
        temperature: 0.2,
        max_tokens: this.options.maxTokens ?? 200,
      });
    } catch (err) {
      throw toLlmError(err, this.options.timeoutMs);
    }

    const content = completion.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new LlmError('LLM response had no message content', true);
    }
    return content;
  }
}

function toLlmError(err: unknown, timeoutMs: number): LlmError {
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new LlmError(`LLM request timed out after ${timeoutMs}ms`, true);
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new LlmError(`LLM request failed: ${err.message}`, true);
  }
  if (err instanceof OpenAI.APIError && err.status !== undefined) {
    // 408/409/429 and 5xx are worth retrying; other 4xx (bad key, unknown model, bad
    // request) will fail the same way every time.
    const status = err.status;
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
    return new LlmError(`LLM answered ${err.message}`.slice(0, 300), retryable, status);
  }
  return new LlmError(`LLM request failed: ${(err as Error).message}`, true);
}
