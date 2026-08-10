/**
 * Integration tests for SPEC-modulo-9-usuarios-permisos.md § 4.5 —
 * GET/POST /panel/roles, PATCH/DELETE /panel/roles/:id.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelRolesPlugin from '../panelRoles.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';
import { createRoleWithPermissions, createSessionCookieForRole, getDueñoRoleId } from '../../test-support/permissionFixtures.js';

function buildApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelRolesPlugin, { db: testDb });
  registerErrorHandler(app);
  return app;
}

// Deliberately does NOT truncate roles/permissions catalog rows — see
// requirePermission.test.ts's resetDb comment. role_permissions/users are
// safe to truncate since every test creates its own throwaway roles/users.
async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE sessions, user_permission_overrides, role_permissions, users RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
  await testDb.deleteFrom('roles').where('is_system', '=', false).execute();
}

beforeEach(resetDb);

async function actingToken(): Promise<string> {
  const roleId = await createRoleWithPermissions(testDb, ['admin.roles']);
  return createSessionCookieForRole(testDb, roleId);
}

describe('authorization (admin.roles)', () => {
  it('403s GET /panel/roles without admin.roles', async () => {
    const roleId = await createRoleWithPermissions(testDb, []);
    const token = await createSessionCookieForRole(testDb, roleId);
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/panel/roles', cookies: { [SESSION_COOKIE_NAME]: token } });
    expect(response.statusCode).toBe(403);
  });

  it('200s GET /panel/roles with admin.roles', async () => {
    const token = await actingToken();
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/panel/roles', cookies: { [SESSION_COOKIE_NAME]: token } });
    expect(response.statusCode).toBe(200);
  });
});

describe('POST /panel/roles', () => {
  it('creates a role with the given permissions', async () => {
    const token = await actingToken();
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/roles',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Recepção Noturna', permissions: ['reservations.view', 'reservations.checkin'] },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.is_owner).toBe(false);
    expect(body.is_system).toBe(false);
    expect(body.permissions.sort()).toEqual(['reservations.checkin', 'reservations.view']);
  });

  it('never accepts is_owner as input — the field is not even in the schema', async () => {
    const token = await actingToken();
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/roles',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Fake Dueño', is_owner: true, permissions: [] },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().is_owner).toBe(false); // silently stripped, never applied
  });

  it('409s on duplicate role name', async () => {
    const token = await actingToken();
    const app = buildApp();
    await app.inject({
      method: 'POST',
      url: '/panel/roles',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Turno Noite', permissions: [] },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/panel/roles',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Turno Noite', permissions: [] },
    });

    expect(response.statusCode).toBe(409);
  });
});

describe('PATCH /panel/roles/:id', () => {
  it('replaces the permission set', async () => {
    const token = await actingToken();
    const app = buildApp();
    const created = await app.inject({
      method: 'POST',
      url: '/panel/roles',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Turno Manhã', permissions: ['reservations.view'] },
    });
    const roleId = created.json().id;

    const response = await app.inject({
      method: 'PATCH',
      url: `/panel/roles/${roleId}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { permissions: ['payments.charge'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().permissions).toEqual(['payments.charge']);
  });

  it('409s editing the Dueño role (is_owner)', async () => {
    const dueñoRoleId = await getDueñoRoleId(testDb);
    const token = await actingToken();
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: `/panel/roles/${dueñoRoleId}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Renamed' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('OWNER_ROLE_NOT_EDITABLE');
  });
});

describe('DELETE /panel/roles/:id', () => {
  it('deletes a role with no assigned users', async () => {
    const token = await actingToken();
    const app = buildApp();
    const created = await app.inject({
      method: 'POST',
      url: '/panel/roles',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Temporário', permissions: [] },
    });
    const roleId = created.json().id;

    const response = await app.inject({
      method: 'DELETE',
      url: `/panel/roles/${roleId}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(204);
  });

  it('409s deleting a system role (Dueño)', async () => {
    const dueñoRoleId = await getDueñoRoleId(testDb);
    const token = await actingToken();
    const app = buildApp();

    const response = await app.inject({
      method: 'DELETE',
      url: `/panel/roles/${dueñoRoleId}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('SYSTEM_ROLE_NOT_DELETABLE');
  });

  it('409s deleting a role with assigned users', async () => {
    const token = await actingToken();
    const app = buildApp();
    const created = await app.inject({
      method: 'POST',
      url: '/panel/roles',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Com Usuário', permissions: [] },
    });
    const roleId = created.json().id;
    await testDb
      .insertInto('users')
      .values({
        email: `${crypto.randomUUID()}@catavento.test`,
        name: 'Assigned User',
        password_hash: await hashPassword('whatever-12345'),
        role_id: roleId,
      })
      .execute();

    const response = await app.inject({
      method: 'DELETE',
      url: `/panel/roles/${roleId}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('ROLE_HAS_ASSIGNED_USERS');
  });
});
