import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { sql } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { registerErrorHandler } from '../../errorHandler.js';
import authPlugin from '../../plugins/auth.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { resetRateLimiterForTests } from '../../auth/loginRateLimiter.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function buildApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(authPlugin, { db: testDb });
  registerErrorHandler(app);
  return app;
}

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE sessions, users RESTART IDENTITY CASCADE`.execute(testDb);
}

interface UserFixtureOptions {
  email?: string;
  password?: string;
  name?: string;
  isActive?: boolean;
}

async function insertTestUser(options: UserFixtureOptions = {}) {
  const email = options.email ?? 'owner@catavento.test';
  const password = options.password ?? 'correct-horse-battery';
  const passwordHash = await hashPassword(password);

  const user = await testDb
    .insertInto('users')
    .values({
      email,
      name: options.name ?? 'Maxi',
      password_hash: passwordHash,
      is_active: options.isActive ?? true,
    })
    .returning(['id', 'email'])
    .executeTakeFirstOrThrow();

  return { ...user, password };
}

// Inserts a session row directly, bypassing createSession(), so tests can
// control exactly how "old" the session is (expires_at implies age, since
// duration is fixed at 30 days) without needing to fake the system clock.
async function insertTestSession(userId: number, expiresAt: Date): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');

  await testDb
    .insertInto('sessions')
    .values({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt })
    .execute();

  return token;
}

function extractCookieValue(setCookieHeader: string | string[] | undefined): string | undefined {
  const header = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  const match = header?.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  return match?.[1];
}

beforeEach(async () => {
  await resetDb();
  resetRateLimiterForTests();
});

describe('POST /panel/auth/login', () => {
  it('sets a session cookie on correct credentials, and /me returns the user', async () => {
    const user = await insertTestUser();
    const app = buildApp();

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/panel/auth/login',
      payload: { email: user.email, password: user.password },
    });

    expect(loginResponse.statusCode).toBe(200);
    expect(loginResponse.json().user.email).toBe(user.email);
    const token = extractCookieValue(loginResponse.headers['set-cookie']);
    expect(token).toBeTruthy();

    const meResponse = await app.inject({
      method: 'GET',
      url: '/panel/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: token! },
    });

    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json().user.email).toBe(user.email);
  });

  it('replies a generic 401 for a wrong password, never distinguishing it from an unknown email', async () => {
    const user = await insertTestUser();
    const app = buildApp();

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/panel/auth/login',
      payload: { email: user.email, password: 'not-the-password' },
    });
    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/panel/auth/login',
      payload: { email: 'nobody@catavento.test', password: 'whatever' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json().error).toBe(unknownEmail.json().error);
  });

  it('locks out after 6 failed attempts for the same email+IP within the window', async () => {
    const user = await insertTestUser();
    const app = buildApp();

    let last;
    for (let i = 0; i < 6; i++) {
      last = await app.inject({
        method: 'POST',
        url: '/panel/auth/login',
        payload: { email: user.email, password: 'wrong' },
      });
    }

    expect(last!.statusCode).toBe(429);
  });

  it('never lets a deactivated user log in', async () => {
    const user = await insertTestUser({ isActive: false });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/auth/login',
      payload: { email: user.email, password: user.password },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('requireAuth on /panel/*', () => {
  it('401s any protected route without a session cookie', async () => {
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/panel/auth/me' });

    expect(response.statusCode).toBe(401);
    expect(response.body).toBe('');
  });

  it('401s once expires_at is in the past, even with a real cookie', async () => {
    const user = await insertTestUser();
    const token = await insertTestSession(user.id, new Date(Date.now() - DAY_MS));
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/panel/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(401);
  });

  it('401s once the owning user has been deactivated after the session was issued', async () => {
    const user = await insertTestUser();
    const token = await insertTestSession(user.id, new Date(Date.now() + 30 * DAY_MS));
    await testDb.updateTable('users').set({ is_active: false }).where('id', '=', user.id).execute();
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/panel/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('session renewal (sliding 30-day expiry)', () => {
  it('pushes expires_at when fewer than 25 days remain (session ~20 days old)', async () => {
    const user = await insertTestUser();
    // ~20 days old out of a 30-day session → ~10 days remaining, under the
    // 25-day renewal threshold.
    const originalExpiresAt = new Date(Date.now() + 10 * DAY_MS);
    const token = await insertTestSession(user.id, originalExpiresAt);
    const app = buildApp();

    await app.inject({
      method: 'GET',
      url: '/panel/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = await testDb
      .selectFrom('sessions')
      .select('expires_at')
      .where('token_hash', '=', tokenHash)
      .executeTakeFirstOrThrow();

    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(originalExpiresAt.getTime());
  });

  it('leaves expires_at untouched when more than 25 days remain (session ~1 day old)', async () => {
    const user = await insertTestUser();
    // ~1 day old out of a 30-day session → ~29 days remaining, above the
    // renewal threshold — no UPDATE should happen.
    const originalExpiresAt = new Date(Date.now() + 29 * DAY_MS);
    const token = await insertTestSession(user.id, originalExpiresAt);
    const app = buildApp();

    await app.inject({
      method: 'GET',
      url: '/panel/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = await testDb
      .selectFrom('sessions')
      .select('expires_at')
      .where('token_hash', '=', tokenHash)
      .executeTakeFirstOrThrow();

    expect(new Date(row.expires_at).getTime()).toBe(originalExpiresAt.getTime());
  });
});

describe('POST /panel/auth/logout', () => {
  it('revokes the current session — the same token stops working', async () => {
    const user = await insertTestUser();
    const app = buildApp();
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/panel/auth/login',
      payload: { email: user.email, password: user.password },
    });
    const token = extractCookieValue(loginResponse.headers['set-cookie'])!;

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/panel/auth/logout',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(logoutResponse.statusCode).toBe(204);

    const meAfterLogout = await app.inject({
      method: 'GET',
      url: '/panel/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(meAfterLogout.statusCode).toBe(401);
  });
});

describe('POST /panel/auth/logout-all', () => {
  it('revokes every session of the user — device B stops working after device A calls logout-all', async () => {
    const user = await insertTestUser();
    const app = buildApp();

    const loginA = await app.inject({
      method: 'POST',
      url: '/panel/auth/login',
      payload: { email: user.email, password: user.password },
    });
    const loginB = await app.inject({
      method: 'POST',
      url: '/panel/auth/login',
      payload: { email: user.email, password: user.password },
    });
    const tokenA = extractCookieValue(loginA.headers['set-cookie'])!;
    const tokenB = extractCookieValue(loginB.headers['set-cookie'])!;

    const logoutAllResponse = await app.inject({
      method: 'POST',
      url: '/panel/auth/logout-all',
      cookies: { [SESSION_COOKIE_NAME]: tokenA },
    });
    expect(logoutAllResponse.statusCode).toBe(204);

    const meFromB = await app.inject({
      method: 'GET',
      url: '/panel/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: tokenB },
    });
    expect(meFromB.statusCode).toBe(401);
  });
});
