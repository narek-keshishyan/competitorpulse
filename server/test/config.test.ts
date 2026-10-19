import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const required = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  LLM_API_KEY: 'sk-test',
};

describe('loadConfig', () => {
  it('applies defaults for everything except the database URL', () => {
    const config = loadConfig(required);

    expect(config.port).toBe(3000);
    expect(config.polling.intervalSeconds).toBe(60);
    expect(config.polling.concurrency).toBe(10);
    expect(config.llm.baseUrl).toBeUndefined();
    expect(config.llm.model).toBe('gpt-4o-mini');
    expect(config.llm.timeoutMs).toBe(15_000);
    expect(config.llm.maxAttempts).toBe(5);
    expect(config.stub.enabled).toBe(true);
    expect(config.workersEnabled).toBe(true);
  });

  it('points the listing source at the built-in stub by default', () => {
    const config = loadConfig({ ...required, PORT: '8080' });

    expect(config.listingSource.baseUrl).toBe('http://127.0.0.1:8080/stub');
  });

  it('coerces numeric and boolean values from strings', () => {
    const config = loadConfig({
      ...required,
      POLL_INTERVAL_SECONDS: '900',
      ENABLE_STUB: 'false',
      WORKERS_ENABLED: 'false',
    });

    expect(config.polling.intervalSeconds).toBe(900);
    expect(config.stub.enabled).toBe(false);
    expect(config.workersEnabled).toBe(false);
  });

  it('requires an API key when talking to OpenAI', () => {
    expect(() => loadConfig({ DATABASE_URL: required.DATABASE_URL })).toThrow(/LLM_API_KEY/);
  });

  it('does not require a key for a custom endpoint such as the mock server', () => {
    const config = loadConfig({
      DATABASE_URL: required.DATABASE_URL,
      LLM_BASE_URL: 'http://localhost:4001/v1',
      LLM_MODEL: 'mock-llm',
    });

    expect(config.llm).toMatchObject({ baseUrl: 'http://localhost:4001/v1', model: 'mock-llm' });
  });

  it('rejects a missing database URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rejects non-positive intervals', () => {
    expect(() => loadConfig({ ...required, POLL_INTERVAL_SECONDS: '0' })).toThrow(
      /POLL_INTERVAL_SECONDS/,
    );
  });
});
