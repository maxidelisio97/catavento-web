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
import { requirePermission } from '../requirePermission.js';
import { SESSION_COOKIE_NAME } from '../cookie.js';

// Deliberately does NOT truncate `roles` or `permissions`: this test file
// runs in the same shared test database as every other suite (vitest here
// has fileParallelism disabled — see server/CLAUDE.md), and those tables
// hold the migration's seeded Dueño/Recepção roles and permission catalog
// that OTHER test files' fixtures rely on by name. Truncating them here
// would silently wipe that seed for every test file that runs afterward in
// the same run. Test-created roles use crypto.randomUUID() names, so they
// never collide with the seeded ones and don't need their own cleanup.
async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE sessions, user_permission_overrides, role_permissions, users RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

async function insertUser(roleId: number | null): Promise<number> {
  const user = await testDb
    .insertInto('users')
    .values({
      email: `${crypto.randomUUID()}@catavento.test`,
      name: 'Test User',
      password_hash: await hashPassword('whatever-12345'),
      role_id: roleId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return user.id;
}

async function insertRole(options: { isOwner?: boolean; permissions?: string[] } = {}): Promise<number> {
  const role = await testDb
    .insertInto('roles')
    .values({ name: crypto.randomUUID(), is_owner: options.isOwner ?? false })
    .returning('id')
    .executeTakeFirstOrThrow();

  for (const permission of options.permissions ?? []) {
    await testDb.insertInto('permissions').values({ key: permission, description: permission }).onConflict((oc) => oc.doNothing()).execute();
    await testDb.insertInto('role_permissions').values({ role_id: role.id, permission }).execute();
  }

  return role.id;
}

// Builds a tiny app with a single protected route gated by
// requireAuth + requirePermission('reservations.view'), mirroring exactly
// how a real panel plugin wires both hooks in the same scope (§ 4.3: "corre
// DESPUÉS de requireAuth").
function buildApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(async (scope) => {
    scope.addHook('onRequest', requireAuth(testDb));
    scope.addHook('onRequest', requirePermission(testDb, 'reservations.view'));
    scope.get('/protected', async () => ({ ok: true }));
  });
  registerErrorHandler(app);
  return app;
}

async function loginToken(userId: number): Promise<string> {
  const { token } = await createSession(testDb, { userId });
  return token;
}

beforeEach(resetDb);

describe('requirePermission', () => {
  it('403s a user whose role does not grant the permission', async () => {
    const roleId = await insertRole({ permissions: ['payments.charge'] });
    const userId = await insertUser(roleId);
    const token = await loginToken(userId);
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toBe('');
  });

  it('200s a user whose role grants the permission', async () => {
    const roleId = await insertRole({ permissions: ['reservations.view'] });
    const userId = await insertUser(roleId);
    const token = await loginToken(userId);
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
  });

  it('403s a user with no role assigned', async () => {
    const userId = await insertUser(null);
    const token = await loginToken(userId);
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(403);
  });

  it('200s a Dueño (is_owner) even without the permission listed on the role', async () => {
    const roleId = await insertRole({ isOwner: true, permissions: [] });
    const userId = await insertUser(roleId);
    const token = await loginToken(userId);
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
  });

  // The anti-self-lockout backdoor § 2.4 explicitly worries about: quitting
  // a permission via a per-user override instead of via the role. Against
  // the real DB (not the pure calc), a Dueño with an override REVOKING the
  // gated permission must still get through.
  it('200s a Dueño even with a user_permission_overrides row revoking the exact gated permission', async () => {
    const roleId = await insertRole({ isOwner: true, permissions: [] });
    const userId = await insertUser(roleId);
    await testDb
      .insertInto('user_permission_overrides')
      .values({ user_id: userId, permission: 'reservations.view', granted: false })
      .execute();
    const token = await loginToken(userId);
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
  });

  it('401s (never even reaches requirePermission) without a valid session', async () => {
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/protected' });

    expect(response.statusCode).toBe(401);
  });
});
