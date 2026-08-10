/**
 * Integration tests for SPEC-modulo-9-usuarios-permisos.md § 4.5 —
 * GET /panel/permissions, GET /panel/me/permissions.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelPermissionsPlugin from '../panelPermissions.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';
import { createRoleWithPermissions, createSessionCookieForRole, getDueñoRoleId } from '../../test-support/permissionFixtures.js';

function buildApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelPermissionsPlugin, { db: testDb });
  registerErrorHandler(app);
  return app;
}

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE sessions, user_permission_overrides, role_permissions, users RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

beforeEach(resetDb);

describe('authorization (admin.users) on GET /panel/permissions', () => {
  it('403s without admin.users', async () => {
    const roleId = await createRoleWithPermissions(testDb, []);
    const token = await createSessionCookieForRole(testDb, roleId);
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/panel/permissions', cookies: { [SESSION_COOKIE_NAME]: token } });
    expect(response.statusCode).toBe(403);
  });

  it('200s with admin.users and lists the full catalog', async () => {
    const roleId = await createRoleWithPermissions(testDb, ['admin.users']);
    const token = await createSessionCookieForRole(testDb, roleId);
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/panel/permissions', cookies: { [SESSION_COOKIE_NAME]: token } });
    expect(response.statusCode).toBe(200);
    const keys = response.json().map((p: { key: string }) => p.key);
    expect(keys).toContain('reservations.view');
    expect(keys).toContain('admin.roles');
  });
});

describe('GET /panel/me/permissions', () => {
  it('401s without a session', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/panel/me/permissions' });
    expect(response.statusCode).toBe(401);
  });

  it('reflects role + overrides for a non-owner', async () => {
    const roleId = await createRoleWithPermissions(testDb, ['reservations.view', 'payments.charge']);
    const token = await createSessionCookieForRole(testDb, roleId);
    const app = buildApp();

    // Grant an override on top of the role, revoke another it does have.
    const user = await testDb
      .selectFrom('sessions')
      .select('user_id')
      .executeTakeFirstOrThrow();
    await testDb
      .insertInto('user_permission_overrides')
      .values([
        { user_id: user.user_id, permission: 'admin.users', granted: true },
        { user_id: user.user_id, permission: 'payments.charge', granted: false },
      ])
      .execute();

    const response = await app.inject({ method: 'GET', url: '/panel/me/permissions', cookies: { [SESSION_COOKIE_NAME]: token } });
    expect(response.statusCode).toBe(200);
    expect(response.json().permissions.sort()).toEqual(['admin.users', 'reservations.view']);
  });

  it('returns the full catalog for a Dueño, ignoring overrides that try to revoke', async () => {
    const dueñoRoleId = await getDueñoRoleId(testDb);
    const token = await createSessionCookieForRole(testDb, dueñoRoleId);
    const app = buildApp();

    const user = await testDb.selectFrom('sessions').select('user_id').executeTakeFirstOrThrow();
    await testDb
      .insertInto('user_permission_overrides')
      .values({ user_id: user.user_id, permission: 'admin.users', granted: false })
      .execute();

    const catalog = await testDb.selectFrom('permissions').select('key').execute();

    const response = await app.inject({ method: 'GET', url: '/panel/me/permissions', cookies: { [SESSION_COOKIE_NAME]: token } });
    expect(response.statusCode).toBe(200);
    expect(response.json().permissions.sort()).toEqual(catalog.map((p) => p.key).sort());
  });

  it('works even for a user with must_change_password=true (no deadlock)', async () => {
    const roleId = await createRoleWithPermissions(testDb, ['reservations.view']);
    const user = await testDb
      .insertInto('users')
      .values({
        email: `${crypto.randomUUID()}@catavento.test`,
        name: 'Pending Change',
        password_hash: await hashPassword('whatever-12345'),
        role_id: roleId,
        must_change_password: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const { createSession } = await import('../../auth/sessionRepository.js');
    const { token } = await createSession(testDb, { userId: user.id });
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/panel/me/permissions', cookies: { [SESSION_COOKIE_NAME]: token } });
    expect(response.statusCode).toBe(200);
  });
});
