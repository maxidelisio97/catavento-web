/**
 * Integration tests for `GET /panel/room-types` — a lightweight, read-only
 * listing of active room types (id + name only). Exists because the panel's
 * "Nova reserva" form needs to populate a room-type dropdown, and reusing
 * `GET /panel/room-rates` for that would force the create-manual flow to
 * also require the `config.settings` permission (room-rates exposes
 * pricing) — a staff member who can create a manual reservation but has no
 * business seeing/editing prices would otherwise see a broken dropdown.
 * Gated by `reservations.create_manual`, same as the rest of this feature.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { Kysely, PostgresDialect, sql, type RootOperationNode } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, testPool } from '../../db/testClient.js';
import type { DB } from '../../db/types.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelRoomTypesPlugin from '../panelRoomTypes.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { createRoleWithPermissions, createSessionCookieForRole, getDueñoRoleId } from '../../test-support/permissionFixtures.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';

function buildApp(db: Kysely<DB> = testDb) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelRoomTypesPlugin, { db });
  registerErrorHandler(app);
  return app;
}

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE room_rates, room_units, rooms, sessions, users RESTART IDENTITY CASCADE`.execute(testDb);
}

async function insertRoom(name: string, active = true): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({ name, capacity: 2, adults_only: false, pets_allowed: false, default_min_stay: 1, active })
    .returning('id')
    .executeTakeFirstOrThrow();
  return room.id;
}

async function insertSessionCookie(): Promise<string> {
  const user = await testDb
    .insertInto('users')
    .values({
      email: 'owner@catavento.test',
      name: 'Maxi',
      password_hash: await hashPassword('whatever'),
      role_id: await getDueñoRoleId(testDb),
    })
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

beforeEach(async () => {
  await resetDb();
});

describe('GET /panel/room-types', () => {
  it('returns only active rooms, id + name only, sorted by name — no rates, no inactive rooms', async () => {
    await insertRoom('Quádruplo');
    await insertRoom('Casal');
    await insertRoom('Descontinuado', false);

    const token = await insertSessionCookie();
    const app = buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/panel/room-types',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      rooms: [
        { id: 2, name: 'Casal' },
        { id: 1, name: 'Quádruplo' },
      ],
    });
  });

  it('401s without a session cookie', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/panel/room-types' });
    expect(res.statusCode).toBe(401);
  });

  it('403s a session without reservations.create_manual', async () => {
    const roleId = await createRoleWithPermissions(testDb, []);
    const token = await createSessionCookieForRole(testDb, roleId);
    const app = buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/panel/room-types',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(res.statusCode).toBe(403);
  });

  it('201s — 200s a session with ONLY reservations.create_manual (no config.settings needed)', async () => {
    const roleId = await createRoleWithPermissions(testDb, ['reservations.create_manual']);
    const token = await createSessionCookieForRole(testDb, roleId);
    await insertRoom('Casal');
    const app = buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/panel/room-types',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(res.statusCode).toBe(200);
  });
});
