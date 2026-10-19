import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { STATUS_CODES } from 'node:http';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { Db } from './db/connection.js';
import type { ListingSource } from './listing-source/http-source.js';
import { listingStubRoutes, type ListingStub } from './listing-source/stub.js';
import { competitorRoutes } from './routes/competitors.js';
import { sendError } from './routes/errors.js';
import { healthRoutes } from './routes/health.js';

export interface AppOptions {
  db: Db;
  listingSource: ListingSource;
  /** When set, the listing stub is served under /stub. */
  stub?: ListingStub;
  onPollRequested?: () => void;
  manualPollCooldownSeconds?: number;
  /** Built web app to serve, with index.html as the fallback for client-side routes. */
  webDistDir?: string;
  /** Per-client request limits for /api; omitted (as in most tests) means no limit. */
  rateLimit?: RateLimitOptions;
  logger?: FastifyServerOptions['logger'];
}

export interface RateLimitOptions {
  /** Requests per minute per client, across the API. */
  perMinute: number;
  /** Requests per minute per client for each endpoint that changes data. */
  writesPerMinute: number;
}

/**
 * Behind Fly's proxy every request comes from the proxy's address. Fly puts the real client
 * address in `Fly-Client-IP` and overwrites whatever the client sent, so it can be trusted.
 */
function clientKey(request: FastifyRequest): string {
  const flyClientIp = request.headers['fly-client-ip'];
  return typeof flyClientIp === 'string' && flyClientIp !== '' ? flyClientIp : request.ip;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  // The API only accepts tiny JSON bodies; refuse anything larger early.
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16 * 1024 });

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      // Fly already redirects to HTTPS; upgrading would break plain-HTTP local runs.
      directives: { upgradeInsecureRequests: null },
    },
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) {
      return sendError(reply, 400, 'bad_request', error.message);
    }
    if (error.statusCode && error.statusCode < 500) {
      // e.g. 413 -> "payload_too_large", 415 -> "unsupported_media_type"
      const code = (STATUS_CODES[error.statusCode] ?? 'bad_request')
        .toLowerCase()
        .replace(/\W+/g, '_');
      return sendError(reply, error.statusCode, code, error.message);
    }
    request.log.error({ err: error }, 'unhandled error');
    return sendError(reply, 500, 'internal_error', 'Something went wrong');
  });

  const isApiRequest = (url: string) => /^\/(api|stub)(\/|$)/.test(url);

  app.setNotFoundHandler((request, reply) => {
    if (options.webDistDir && request.method === 'GET' && !isApiRequest(request.url)) {
      return reply.sendFile('index.html');
    }
    return sendError(reply, 404, 'not_found', `No route for ${request.method} ${request.url}`);
  });

  if (options.webDistDir) {
    await app.register(fastifyStatic, { root: options.webDistDir, wildcard: false });
  }

  // Health probes and the stub are hit constantly by machines; keep them out of the info logs.
  await app.register(healthRoutes, { db: options.db, logLevel: 'warn' });
  await app.register(
    async (api) => {
      const { rateLimit } = options;
      if (rateLimit) {
        // Registered inside the /api scope only: health probes, the stub (called by our own
        // poller) and static assets stay unlimited.
        await api.register(fastifyRateLimit, {
          max: rateLimit.perMinute,
          timeWindow: '1 minute',
          keyGenerator: clientKey,
          errorResponseBuilder: (_request, context) => ({
            statusCode: 429,
            message: `Too many requests; try again in ${Math.ceil(context.ttl / 1000)}s`,
          }),
        });
      }
      await api.register(competitorRoutes, {
        db: options.db,
        listingSource: options.listingSource,
        onPollRequested: options.onPollRequested,
        manualPollCooldownSeconds: options.manualPollCooldownSeconds ?? 10,
        writesPerMinute: rateLimit?.writesPerMinute,
      });
    },
    { prefix: '/api' },
  );
  if (options.stub) {
    await app.register(listingStubRoutes, {
      prefix: '/stub',
      stub: options.stub,
      logLevel: 'warn',
    });
  }

  return app;
}
