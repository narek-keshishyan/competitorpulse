import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { LlmError, OpenAiCompatibleClient } from '../src/summaries/llm-client.js';

type Behaviour = { status: number; body: unknown; delayMs?: number };

describe('OpenAiCompatibleClient', () => {
  let server: FastifyInstance;
  let baseUrl: string;
  let behaviour: Behaviour;
  let lastRequest: { headers: Record<string, unknown>; body: Record<string, unknown> } | undefined;

  beforeAll(async () => {
    // Close sockets left open by aborted (timed-out) requests so teardown is instant.
    server = Fastify({ forceCloseConnections: true });
    server.post('/v1/chat/completions', async (request, reply) => {
      lastRequest = {
        headers: request.headers,
        body: request.body as Record<string, unknown>,
      };
      if (behaviour.delayMs) await new Promise((r) => setTimeout(r, behaviour.delayMs));
      return reply.code(behaviour.status).send(behaviour.body);
    });
    baseUrl = `${await server.listen({ port: 0, host: '127.0.0.1' })}/v1`;
  });

  beforeEach(() => {
    lastRequest = undefined;
    behaviour = {
      status: 200,
      body: { choices: [{ message: { role: 'assistant', content: '  Price dropped.  ' } }] },
    };
  });

  afterAll(async () => {
    await server.close();
  });

  const client = (timeoutMs = 1_000) =>
    new OpenAiCompatibleClient({ baseUrl, apiKey: 'test-key', model: 'test-model', timeoutMs });

  it('sends a chat completion request and returns the trimmed answer', async () => {
    const text = await client().complete([{ role: 'user', content: 'hi' }]);

    expect(text).toBe('Price dropped.');
    expect(lastRequest?.headers.authorization).toBe('Bearer test-key');
    expect(lastRequest?.body).toMatchObject({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('treats server errors as retryable', async () => {
    behaviour = { status: 500, body: { error: { message: 'injected failure' } } };

    const err = await client()
      .complete([{ role: 'user', content: 'hi' }])
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ retryable: true, status: 500 });
  });

  it('treats rate limiting as retryable', async () => {
    behaviour = { status: 429, body: {} };

    await expect(client().complete([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('treats bad credentials as permanent', async () => {
    behaviour = { status: 401, body: { error: { message: 'bad key' } } };

    await expect(client().complete([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      retryable: false,
      status: 401,
    });
  });

  it('times out instead of hanging on a slow model', async () => {
    behaviour = { ...behaviour, delayMs: 300 };

    await expect(client(50).complete([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      retryable: true,
      message: expect.stringMatching(/timed out/),
    });
  });

  it('rejects a response without any content', async () => {
    behaviour = { status: 200, body: { choices: [] } };

    await expect(client().complete([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(
      LlmError,
    );
  });
});
