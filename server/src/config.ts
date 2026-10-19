import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();
const booleanFlag = z.stringbool();

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: positiveInt.default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    // Hosted Postgres (e.g. Supabase) needs TLS; local docker Postgres does not.
    DATABASE_SSL: booleanFlag.default(false),
    // PEM of the server's CA. When set, the certificate is verified; without it TLS still
    // encrypts but does not authenticate the server.
    DATABASE_SSL_CA: z.string().optional(),
    DATABASE_POOL_MAX: positiveInt.default(10),

    // Where the poller fetches listings from. Defaults to the stub served by this process.
    LISTING_SOURCE_URL: z.url().optional(),
    LISTING_FETCH_TIMEOUT_MS: positiveInt.default(5_000),
    ENABLE_STUB: booleanFlag.default(true),
    LISTING_FIXTURES_PATH: z
      .string()
      .default(fileURLToPath(new URL('../fixtures/listings.json', import.meta.url))),

    // Lets you run API-only replicas while a separate deployment runs the background loops.
    WORKERS_ENABLED: booleanFlag.default(true),

    POLL_INTERVAL_SECONDS: positiveInt.default(60),
    POLL_TICK_MS: positiveInt.default(5_000),
    POLL_BATCH_SIZE: positiveInt.default(50),
    POLL_CONCURRENCY: positiveInt.default(10),
    // Minimum time between two accepted "Poll now" requests for the same competitor.
    MANUAL_POLL_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(10),

    // Unset means OpenAI's own API (the SDK default). Set it for any other OpenAI-compatible
    // endpoint: the bundled mock server, Ollama, Anthropic's compatibility endpoint, ...
    LLM_BASE_URL: z.url().optional(),
    LLM_API_KEY: z.string().min(1).optional(),
    LLM_MODEL: z.string().min(1).default('gpt-4o-mini'),
    LLM_TIMEOUT_MS: positiveInt.default(15_000),
    LLM_MAX_ATTEMPTS: positiveInt.default(5),
    LLM_CONCURRENCY: positiveInt.default(4),
    SUMMARY_TICK_MS: positiveInt.default(3_000),
    SUMMARY_RETRY_BASE_MS: positiveInt.default(5_000),
    SUMMARY_RETRY_MAX_MS: positiveInt.default(5 * 60_000),

    WEB_DIST_DIR: z.string().optional(),
  })
  .refine((env) => env.LLM_BASE_URL !== undefined || env.LLM_API_KEY !== undefined, {
    path: ['LLM_API_KEY'],
    message: 'is required when LLM_BASE_URL is not set (OpenAI)',
  });

export type Env = z.input<typeof envSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  const e = parsed.data;

  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    database: {
      url: e.DATABASE_URL,
      ssl: e.DATABASE_SSL,
      sslCa: e.DATABASE_SSL_CA,
      poolMax: e.DATABASE_POOL_MAX,
    },
    listingSource: {
      baseUrl: e.LISTING_SOURCE_URL ?? `http://127.0.0.1:${e.PORT}/stub`,
      timeoutMs: e.LISTING_FETCH_TIMEOUT_MS,
    },
    stub: {
      enabled: e.ENABLE_STUB,
      fixturesPath: e.LISTING_FIXTURES_PATH,
    },
    workersEnabled: e.WORKERS_ENABLED,
    polling: {
      intervalSeconds: e.POLL_INTERVAL_SECONDS,
      tickMs: e.POLL_TICK_MS,
      batchSize: e.POLL_BATCH_SIZE,
      concurrency: e.POLL_CONCURRENCY,
      manualCooldownSeconds: e.MANUAL_POLL_COOLDOWN_SECONDS,
    },
    llm: {
      baseUrl: e.LLM_BASE_URL,
      // Local endpoints (mock server, Ollama) accept any key, but the SDK insists on one.
      apiKey: e.LLM_API_KEY ?? 'not-needed',
      model: e.LLM_MODEL,
      timeoutMs: e.LLM_TIMEOUT_MS,
      maxAttempts: e.LLM_MAX_ATTEMPTS,
      concurrency: e.LLM_CONCURRENCY,
    },
    summaries: {
      tickMs: e.SUMMARY_TICK_MS,
      retryBaseMs: e.SUMMARY_RETRY_BASE_MS,
      retryMaxMs: e.SUMMARY_RETRY_MAX_MS,
    },
    webDistDir: e.WEB_DIST_DIR,
  };
}

export type Config = ReturnType<typeof loadConfig>;
