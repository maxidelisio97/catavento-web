/**
 * Integration tests for SPEC-modulo-8-configuracion.md § 4.2 — GET/PATCH
 * /panel/settings.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelSettingsPlugin from '../panelSettings.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';

const SETTING_KEYS = ['deposit_percent', 'hold_minutes', 'pet_fee_cents'] as const;

function buildApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelSettingsPlugin, { db: testDb });
  registerErrorHandler(app);
  return app;
}

async function insertSessionCookie(): Promise<string> {
  const user = await testDb
    .insertInto('users')
    .values({ email: 'owner@catavento.test', name: 'Maxi', password_hash: await hashPassword('whatever') })
    .returning('id')
    .executeTakeFirstOrThrow();

  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await testDb
    .insertInto('sessions')
    .values({ user_id: user.id, token_hash: tokenHash, expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) })
    .execute();

  return token;
}

// `settings` holds the seeded business config other test files read while
// this file's tests run (fileParallelism is false, but nothing here should
// leak state across files) — snapshot and restore instead of truncating,
// same pattern as settings/__tests__/settings.test.ts.
let seedRows: { key: string; value: string }[] = [];

beforeAll(async () => {
  seedRows = await testDb.selectFrom('settings').select(['key', 'value']).where('key', 'in', SETTING_KEYS).execute();
});

beforeEach(async () => {
  await testDb.deleteFrom('users').execute();
  await testDb.deleteFrom('sessions').execute();
});

afterEach(async () => {
  await testDb.deleteFrom('settings').where('key', 'in', SETTING_KEYS).execute();
  await testDb.insertInto('settings').values(seedRows).execute();
});

describe('GET /panel/settings', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/panel/settings' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the current settings', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/panel/settings',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deposit_percent: 50, hold_minutes: 30, pet_fee_cents: 3000 });
  });
});

describe('PATCH /panel/settings', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'PATCH', url: '/panel/settings', payload: { hold_minutes: 20 } });
    expect(response.statusCode).toBe(401);
  });

  it('updates only the keys sent, leaving the rest untouched', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/settings',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { hold_minutes: 45 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deposit_percent: 50, hold_minutes: 45, pet_fee_cents: 3000 });

    const getResponse = await app.inject({
      method: 'GET',
      url: '/panel/settings',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(getResponse.json()).toEqual({ deposit_percent: 50, hold_minutes: 45, pet_fee_cents: 3000 });
  });

  it('rejects hold_minutes below the 15-minute floor', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/settings',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { hold_minutes: 10 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects deposit_percent outside 0-100', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/settings',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { deposit_percent: 150 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('accepts pet_fee_cents of 0', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/settings',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { pet_fee_cents: 0 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().pet_fee_cents).toBe(0);
  });
});
