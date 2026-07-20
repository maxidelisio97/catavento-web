import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../errorHandler.js';

function buildApp() {
  const app = Fastify();
  registerErrorHandler(app);
  return app;
}

describe('registerErrorHandler', () => {
  it('returns the real status code and the error message for a 4xx error', async () => {
    const app = buildApp();
    app.get('/boom', async () => {
      const err = new Error('bad input') as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    });

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'bad input' });
  });

  it('returns a generic message and 500 for an unexpected error, without leaking its detail', async () => {
    const app = buildApp();
    app.get('/boom', async () => {
      throw new Error('unexpected: connection string leaked');
    });

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internal_error' });
  });
});
