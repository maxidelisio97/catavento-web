/**
 * Integration tests for SPEC-modulo-9-usuarios-permisos.md § 4.5 —
 * GET/POST /panel/users, PATCH /panel/users/:id,
 * PATCH /panel/users/:id/overrides, POST /panel/users/:id/deactivate.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelUsersPlugin from '../panelUsers.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';
import {
  createRoleWithPermissions,
  createSessionCookieForRole,
  getDueñoRoleId,
} from '../../test-support/permissionFixtures.js';

function buildApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelUsersPlugin, { db: testDb });
  registerErrorHandler(app);
  return app;
}

// Deliberately does NOT truncate roles/permissions — see
// requirePermission.test.ts's resetDb comment.
async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE sessions, user_permission_overrides, users RESTART IDENTITY CASCADE`.execute(testDb);
}

async function insertUser(roleId: number | null, options: { isActive?: boolean } = {}): Promise<number> {
  const user = await testDb
    .insertInto('users')
    .values({
      email: `${crypto.randomUUID()}@catavento.test`,
      name: 'Fixture User',
      password_hash: await hashPassword('whatever-12345'),
      role_id: roleId,
      is_active: options.isActive ?? true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return user.id;
}

beforeEach(resetDb);

describe('authorization (admin.users)', () => {
  it('403s GET /panel/users without admin.users', async () => {
    const roleId = await createRoleWithPermissions(testDb, []);
    const token = await createSessionCookieForRole(testDb, roleId);
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/panel/users', cookies: { [SESSION_COOKIE_NAME]: token } });
    expect(response.statusCode).toBe(403);
  });

  it('200s GET /panel/users with admin.users', async () => {
    const roleId = await createRoleWithPermissions(testDb, ['admin.users']);
    const token = await createSessionCookieForRole(testDb, roleId);
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/panel/users', cookies: { [SESSION_COOKIE_NAME]: token } });
    expect(response.statusCode).toBe(200);
  });
});

describe('POST /panel/users', () => {
  it('creates the user with must_change_password=true always', async () => {
    const dueñoRoleId = await getDueñoRoleId(testDb);
    const token = await createSessionCookieForRole(testDb, dueñoRoleId);
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/users',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { email: 'new-staff@catavento.test', name: 'Nova Funcionária', password: 'temporary123' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.must_change_password).toBe(true);

    const row = await testDb
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', body.id)
      .executeTakeFirstOrThrow();
    expect(row.password_hash).not.toBe('temporary123'); // hashed, never stored raw
  });

  it('409s on duplicate email', async () => {
    const dueñoRoleId = await getDueñoRoleId(testDb);
    const token = await createSessionCookieForRole(testDb, dueñoRoleId);
    await insertUser(dueñoRoleId);
    const app = buildApp();

    const existing = await testDb.selectFrom('users').select('email').executeTakeFirstOrThrow();
    const response = await app.inject({
      method: 'POST',
      url: '/panel/users',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { email: existing.email, name: 'Dup', password: 'temporary123' },
    });

    expect(response.statusCode).toBe(409);
  });
});

describe('anti-self-lockout guard (§ 2.4)', () => {
  it('409s demoting the last remaining active Dueño (single-owner setup)', async () => {
    const dueñoRoleId = await getDueñoRoleId(testDb);
    const lastOwnerId = await insertUser(dueñoRoleId);
    // The acting session is a non-owner role with admin.users — so it's
    // never itself counted as an active owner and can't accidentally get
    // caught by "deactivate every other owner" below.
    const actingRoleId = await createRoleWithPermissions(testDb, ['admin.users']);
    const token = await createSessionCookieForRole(testDb, actingRoleId);
    const staffRoleId = await createRoleWithPermissions(testDb, []);
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: `/panel/users/${lastOwnerId}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { role_id: staffRoleId },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('LAST_OWNER_LOCKOUT');

    const row = await testDb.selectFrom('users').select('role_id').where('id', '=', lastOwnerId).executeTakeFirstOrThrow();
    expect(row.role_id).toBe(dueñoRoleId); // untouched
  });

  it('allows demoting one Dueño when another active Dueño remains', async () => {
    const dueñoRoleId = await getDueñoRoleId(testDb);
    const ownerA = await insertUser(dueñoRoleId);
    await insertUser(dueñoRoleId); // ownerB, keeps the count at 2
    const actingRoleId = await createRoleWithPermissions(testDb, ['admin.users']);
    const token = await createSessionCookieForRole(testDb, actingRoleId);
    const staffRoleId = await createRoleWithPermissions(testDb, []);
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: `/panel/users/${ownerA}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { role_id: staffRoleId },
    });

    expect(response.statusCode).toBe(200);
  });

  it('409s deactivating the last remaining active Dueño', async () => {
    const dueñoRoleId = await getDueñoRoleId(testDb);
    const lastOwnerId = await insertUser(dueñoRoleId);
    const actingRoleId = await createRoleWithPermissions(testDb, ['admin.users']);
    const token = await createSessionCookieForRole(testDb, actingRoleId);
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/users/${lastOwnerId}/deactivate`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('LAST_OWNER_LOCKOUT');
  });

  it('allows deactivating one Dueño when another active Dueño remains', async () => {
    const dueñoRoleId = await getDueñoRoleId(testDb);
    const ownerA = await insertUser(dueñoRoleId);
    await insertUser(dueñoRoleId); // ownerB
    const actingRoleId = await createRoleWithPermissions(testDb, ['admin.users']);
    const token = await createSessionCookieForRole(testDb, actingRoleId);
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/users/${ownerA}/deactivate`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('PATCH /panel/users/:id/overrides', () => {
  it('sets, then removes, an override', async () => {
    const dueñoRoleId = await getDueñoRoleId(testDb);
    const token = await createSessionCookieForRole(testDb, dueñoRoleId);
    const staffRoleId = await createRoleWithPermissions(testDb, []);
    const staffUserId = await insertUser(staffRoleId);
    const app = buildApp();

    const grant = await app.inject({
      method: 'PATCH',
      url: `/panel/users/${staffUserId}/overrides`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { overrides: [{ permission: 'reservations.view', granted: true }] },
    });
    expect(grant.statusCode).toBe(204);

    let row = await testDb
      .selectFrom('user_permission_overrides')
      .selectAll()
      .where('user_id', '=', staffUserId)
      .executeTakeFirstOrThrow();
    expect(row.granted).toBe(true);

    const remove = await app.inject({
      method: 'PATCH',
      url: `/panel/users/${staffUserId}/overrides`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { overrides: [{ permission: 'reservations.view', granted: null }] },
    });
    expect(remove.statusCode).toBe(204);

    const rows = await testDb
      .selectFrom('user_permission_overrides')
      .selectAll()
      .where('user_id', '=', staffUserId)
      .execute();
    expect(rows).toHaveLength(0);
  });
});
