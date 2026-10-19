import type { FastifyReply } from 'fastify';
import type { ApiError } from '@competitorpulse/shared';

export function sendError(reply: FastifyReply, status: number, error: string, message: string) {
  const body: ApiError = { error, message };
  return reply.code(status).send(body);
}
