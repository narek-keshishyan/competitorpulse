import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { healthRoutes } from './routes/health.js';

export interface AppOptions {
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(healthRoutes);

  return app;
}
