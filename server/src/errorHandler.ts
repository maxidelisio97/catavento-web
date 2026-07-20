import type { FastifyError, FastifyInstance } from 'fastify';

/**
 * 4xx (validation, bad input) keeps its real status code and surfaces the
 * error message, so the caller knows what it sent wrong. Anything else is
 * an unexpected failure: log the detail, return a generic 500 — never leak
 * internals to the client.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, _request, reply) => {
    const statusCode = err.statusCode ?? 500;

    if (statusCode >= 400 && statusCode < 500) {
      app.log.warn(err);
      reply.status(statusCode).send({ error: err.message });
      return;
    }

    app.log.error(err);
    reply.status(500).send({ error: 'internal_error' });
  });
}
