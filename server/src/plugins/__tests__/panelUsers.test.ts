/**
 * Integration tests for SPEC-modulo-9-usuarios-permisos.md § 4.5 —
 * GET/POST /panel/users, PATCH /panel/users/:id,
 * PATCH /panel/users/:id/overrides, POST /panel/users/:id/deactivate.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { Kysely, PostgresDialect, sql, type RootOperationNode } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../db/types.js';
import { testDb, testPool } from '../../db/testClient.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelUsersPlugin from '../panelUsers.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';
import { createQueryTimingPlugin, getProcessId, selectReferencesTable, waitForLockWait } from '../../test-support/queryBarrier.js';
import {
  createRoleWithPermissions,
  createSessionCookieForRole,
  getDueñoRoleId,
} from '../../test-support/permissionFixtures.js';

function buildApp(db: Kysely<DB> = testDb) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelUsersPlugin, { db });
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

  // Identifies ownerGuard.countActiveOwners' OWN `users` JOIN `roles`
  // `FOR UPDATE` query specifically — NOT isCurrentlyActiveOwner's separate
  // `users`/`roles` select (selects 2 columns, `is_owner`/`is_active`, no
  // lock). Both reference the same two tables, so they're only
  // distinguishable by their column list: this one selects exactly `id`.
  function isActiveOwnersForUpdateQuery(node: RootOperationNode): boolean {
    if (!selectReferencesTable(node, 'users') || !selectReferencesTable(node, 'roles')) return false;
    const selections = (node as { selections?: { selection?: { column?: { column?: { name?: string } } } }[] })
      .selections;
    return (selections?.length ?? 0) === 1 && selections![0]!.selection?.column?.column?.name === 'id';
  }

  // DETERMINISTIC, same technique as panelRateOverrides.test.ts's cupo-guard
  // lock test and panelManualReservation.test.ts's createReservation lock
  // test: a raw connection holds the EXACT `users`+`roles` FOR UPDATE lock
  // countActiveOwners takes (simulating a first demotion already in flight,
  // lock acquired, not yet committed), while the REAL
  // POST /panel/users/:id/deactivate endpoint for a SECOND active Dueño runs
  // concurrently through the actual plugin code. Proves the exact race
  // ownerGuard.ts's own doc comment calls out: "two concurrent demotions of
  // the last two owners can't both read '2 owners, safe' and both proceed".
  it(
    'DETERMINISTIC: two concurrent demotions of the last two active Dueños — one wins, the other is rejected, never zero active Dueños',
    async () => {
      const dueñoRoleId = await getDueñoRoleId(testDb);
      const ownerA = await insertUser(dueñoRoleId);
      const ownerB = await insertUser(dueñoRoleId);
      const actingRoleId = await createRoleWithPermissions(testDb, ['admin.users']);
      const token = await createSessionCookieForRole(testDb, actingRoleId);

      // Warm the pool first — a cold connection's first query can cost 300-400ms on its own.
      await Promise.all([
        testDb.selectFrom('users').select('id').limit(1).execute(),
        testDb.selectFrom('users').select('id').limit(1).execute(),
      ]);

      const holder = await testPool.connect();
      const { plugin: timingPlugin, timings } = createQueryTimingPlugin({ match: isActiveOwnersForUpdateQuery });
      const measuredDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: testPool }), plugins: [timingPlugin] });
      const app = buildApp(measuredDb);

      let deactivatePromise!: Promise<Awaited<ReturnType<typeof app.inject>>>;
      let sawGenuineLockWait = false;
      try {
        await holder.query('BEGIN');
        await holder.query(
          `SELECT users.id FROM users JOIN roles ON roles.id = users.role_id
           WHERE roles.is_owner = true AND users.is_active = true FOR UPDATE`,
        );

        // Simulates ownerB's demotion already in flight (holds the lock,
        // about to apply its own change) while ownerA's REAL deactivate
        // request runs concurrently through the actual guard code.
        deactivatePromise = Promise.resolve(
          app.inject({
            method: 'POST',
            url: `/panel/users/${ownerA}/deactivate`,
            cookies: { [SESSION_COOKIE_NAME]: token },
          }),
        );
        deactivatePromise.catch(() => {});

        sawGenuineLockWait = await waitForLockWait(testPool, {
          excludePids: [getProcessId(holder)],
          queryContains: 'roles',
        });

        // Finish what the holder's demotion does, still holding the lock:
        // deactivate ownerB, leaving ownerA as the only active Dueño.
        await holder.query('UPDATE users SET is_active = false WHERE id = $1', [ownerB]);
        await holder.query('COMMIT');
      } catch (err) {
        await holder.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        holder.release();
      }

      expect(sawGenuineLockWait).toBe(true);

      const response = await deactivatePromise;
      // ownerA's demotion woke up AFTER ownerB's committed, re-read the
      // active-owner count under lock, saw only 1 left, and correctly
      // rejected — never both proceeding.
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('LAST_OWNER_LOCKOUT');

      // Confirms the wait was on the SPECIFIC FOR UPDATE query, not some
      // other point in the call.
      expect(timings).toHaveLength(1);

      const activeOwners = await testDb
        .selectFrom('users')
        .innerJoin('roles', 'roles.id', 'users.role_id')
        .select('users.id')
        .where('roles.is_owner', '=', true)
        .where('users.is_active', '=', true)
        .execute();
      expect(activeOwners).toHaveLength(1); // exactly one — never zero, never both untouched
      expect(activeOwners[0]!.id).toBe(ownerA);
    },
    15000,
  );
});

describe('GET /panel/users/:id/overrides', () => {
  it('403s without admin.users', async () => {
    const dueñoRoleId = await getDueñoRoleId(testDb);
    const targetUserId = await insertUser(dueñoRoleId);
    const roleId = await createRoleWithPermissions(testDb, []);
    const token = await createSessionCookieForRole(testDb, roleId);
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: `/panel/users/${targetUserId}/overrides`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(403);
  });

  it('200s with admin.users and returns the user\'s existing overrides', async () => {
    const dueñoRoleId = await getDueñoRoleId(testDb);
    const token = await createSessionCookieForRole(testDb, dueñoRoleId);
    const staffRoleId = await createRoleWithPermissions(testDb, []);
    const staffUserId = await insertUser(staffRoleId);
    await testDb
      .insertInto('user_permission_overrides')
      .values({ user_id: staffUserId, permission: 'reservations.view', granted: true })
      .execute();
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: `/panel/users/${staffUserId}/overrides`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ permission: 'reservations.view', granted: true }]);
  });

  it('404s for a user that does not exist', async () => {
    const dueñoRoleId = await getDueñoRoleId(testDb);
    const token = await createSessionCookieForRole(testDb, dueñoRoleId);
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/panel/users/999999/overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(404);
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
