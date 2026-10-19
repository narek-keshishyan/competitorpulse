import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const required = { DATABASE_URL: 'postgres://user:pass@localhost:5432/db' };

describe('loadConfig', () => {
  it('applies defaults for everything except the database URL', () => {
    const config = loadConfig(required);

    expect(config.port).toBe(3000);
    expect(config.polling.intervalSeconds).toBe(60);
    expect(config.polling.concurrency).toBe(10);
    expect(config.llm.baseUrl).toBe('http://localhost:4001/v1');
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

  it('rejects a missing database URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rejects non-positive intervals', () => {
    expect(() => loadConfig({ ...required, POLL_INTERVAL_SECONDS: '0' })).toThrow(
      /POLL_INTERVAL_SECONDS/,
    );
  });
});
