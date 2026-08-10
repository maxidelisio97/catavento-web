import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { registerErrorHandler } from '../../errorHandler.js';
import { hashPassword } from '../hashPassword.js';
import { createSession } from '../sessionRepository.js';
import { requireAuth } from '../requireAuth.js';
import { blockIfMustChangePassword } from '../blockIfMustChangePassword.js';
import { SESSION_COOKIE_NAME } from '../cookie.js';

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE sessions, users RESTART IDENTITY CASCADE`.execute(testDb);
}

async function insertUser(mustChangePassword: boolean): Promise<number> {
  const user = await testDb
    .insertInto('users')
    .values({
      email: `${crypto.randomUUID()}@catavento.test`,
      name: 'Test User',
      password_hash: await hashPassword('whatever-12345'),
      must_change_password: mustChangePassword,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return user.id;
}

// Mirrors how a real panel plugin (other than auth.ts's own protected
// scope, which deliberately omits this hook) wires both hooks together.
function buildApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(async (scope) => {
    scope.addHook('onRequest', requireAuth(testDb));
    scope.addHook('onRequest', blockIfMustChangePassword());
    scope.get('/protected', async () => ({ ok: true }));
  });
  registerErrorHandler(app);
  return app;
}

beforeEach(resetDb);

describe('blockIfMustChangePassword', () => {
  it('403s with MUST_CHANGE_PASSWORD when the flag is set', async () => {
    const userId = await insertUser(true);
    const { token } = await createSession(testDb, { userId });
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'MUST_CHANGE_PASSWORD' });
  });

  it('200s when the flag is not set', async () => {
    const userId = await insertUser(false);
    const { token } = await createSession(testDb, { userId });
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
  });
});
