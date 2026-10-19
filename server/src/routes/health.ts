import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../db/connection.js';
import { sendError } from './errors.js';

export const healthRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  // Liveness: the process is up. Deliberately does not touch the database, so a database
  // outage doesn't get every instance restarted.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness: the process can serve requests.
  app.get('/readyz', async (request, reply) => {
    try {
      await sql`select 1`.execute(db);
      return { status: 'ready' };
    } catch (err) {
      request.log.error({ err }, 'readiness check failed');
      return sendError(reply, 503, 'not_ready', 'Database is unreachable');
    }
  });
};
