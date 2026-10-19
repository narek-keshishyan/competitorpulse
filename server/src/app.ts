import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
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
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) {
      return sendError(reply, 400, 'bad_request', error.message);
    }
    if (error.statusCode && error.statusCode < 500) {
      return sendError(reply, error.statusCode, 'bad_request', error.message);
    }
    request.log.error({ err: error }, 'unhandled error');
    return sendError(reply, 500, 'internal_error', 'Something went wrong');
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(reply, 404, 'not_found', `No route for ${request.method} ${request.url}`),
  );

  await app.register(healthRoutes, { db: options.db });
  await app.register(competitorRoutes, {
    prefix: '/api',
    db: options.db,
    listingSource: options.listingSource,
    onPollRequested: options.onPollRequested,
  });
  if (options.stub) {
    await app.register(listingStubRoutes, { prefix: '/stub', stub: options.stub });
  }

  return app;
}
