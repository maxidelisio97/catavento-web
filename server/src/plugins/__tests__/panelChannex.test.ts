/**
 * Integration tests for SPEC-modulo-12A-otas-fundaciones-mapeo.md § 5 —
 * GET/PATCH /panel/channex/config, POST /panel/channex/test-connection
 * (entrega 1), and GET /panel/channex/room-types, PUT
 * /panel/channex/room-type-map, GET /panel/channex/mapping-status
 * (entrega 2). listRoomTypes is mocked here for a deterministic suite — its
 * real behavior against Channex staging is exercised separately by
 * scripts/test-channex-connection.ts (manual, needs a real CHANNEX_API_KEY).
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { registerErrorHandler } from '../../errorHandler.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { createRoleWithPermissions, createSessionCookieForRole, getDueñoRoleId } from '../../test-support/permissionFixtures.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';

const { getProperty, listRoomTypes, fetchBookingRevisionsFeed, ackBookingRevision } = vi.hoisted(() => ({
  getProperty: vi.fn(),
  listRoomTypes: vi.fn(),
  fetchBookingRevisionsFeed: vi.fn().mockResolvedValue([]),
  ackBookingRevision: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../channex/channexClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../channex/channexClient.js')>();
  return { ...actual, getProperty, listRoomTypes, fetchBookingRevisionsFeed, ackBookingRevision };
});

const panelChannexPlugin = (await import('../panelChannex.js')).default;

function buildApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelChannexPlugin, { db: testDb });
  registerErrorHandler(app);
  return app;
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

async function insertRoom(name: string): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({ name, capacity: 2, adults_only: false, pets_allowed: false, default_min_stay: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();
  return room.id;
}

beforeEach(async () => {
  await sql`TRUNCATE TABLE sessions, users RESTART IDENTITY CASCADE`.execute(testDb);
  await sql`TRUNCATE TABLE rooms RESTART IDENTITY CASCADE`.execute(testDb);
  await testDb.deleteFrom('channex_config').execute();
  getProperty.mockReset();
  listRoomTypes.mockReset();
});

afterEach(async () => {
  await testDb.deleteFrom('channex_config').execute();
  await sql`TRUNCATE TABLE rooms RESTART IDENTITY CASCADE`.execute(testDb);
});

describe('GET /panel/channex/config', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/panel/channex/config' });
    expect(response.statusCode).toBe(401);
  });

  it('returns disconnected defaults when no row exists yet', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/panel/channex/config',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ connected: false, environment: 'staging', property_id: null, is_active: false });
  });

  it('never returns the API key in any form', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/panel/channex/config',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(Object.keys(response.json())).not.toContain('api_key');
    expect(Object.keys(response.json())).not.toContain('apiKey');
  });
});

describe('PATCH /panel/channex/config', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'PATCH', url: '/panel/channex/config', payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it('sets property_id and is_active, and reflects them back', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/channex/config',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { property_id: 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f', is_active: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connected: true,
      environment: 'staging',
      property_id: 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f',
      is_active: true,
    });
  });

  it('ignores an environment field if sent — it is derived from CHANNEX_ENV, never PATCH-able', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/channex/config',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { environment: 'production' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environment).toBe('staging');
  });

  it('rejects an invalid property_id', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/channex/config',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { property_id: 'not-a-uuid' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('POST /panel/channex/test-connection', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'POST', url: '/panel/channex/test-connection' });
    expect(response.statusCode).toBe(401);
  });

  it('returns ok:false without calling Channex when property_id is not configured', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/channex/test-connection',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: false, error: 'property_id não configurado' });
    expect(getProperty).not.toHaveBeenCalled();
  });

  it('returns ok:true with the property title on success', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();
    await app.inject({
      method: 'PATCH',
      url: '/panel/channex/config',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { property_id: 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f', is_active: true },
    });
    getProperty.mockResolvedValue({ id: 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f', title: 'Pousada Catavento' });

    const response = await app.inject({
      method: 'POST',
      url: '/panel/channex/test-connection',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      property: { id: 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f', title: 'Pousada Catavento' },
    });
  });

  it('reduces a ChannexApiError to a status code, never the raw Channex error body', async () => {
    const { ChannexApiError } = await import('../../channex/channexClient.js');
    const token = await insertSessionCookie();
    const app = buildApp();
    await app.inject({
      method: 'PATCH',
      url: '/panel/channex/config',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { property_id: 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f', is_active: true },
    });
    getProperty.mockRejectedValue(new ChannexApiError(401, { errors: { code: 'unauthorized', detail: 'super-secret-context' } }));

    const response = await app.inject({
      method: 'POST',
      url: '/panel/channex/test-connection',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: false, error: 'Channex respondeu 401' });
    expect(JSON.stringify(response.json())).not.toContain('super-secret-context');
  });
});

describe('GET /panel/channex/room-types', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/panel/channex/room-types' });
    expect(response.statusCode).toBe(401);
  });

  it('400s without calling Channex when property_id is not configured', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/panel/channex/room-types',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(400);
    expect(listRoomTypes).not.toHaveBeenCalled();
  });

  it('merges Channex room types with local rooms and their current mapping', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();
    await app.inject({
      method: 'PATCH',
      url: '/panel/channex/config',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { property_id: 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f', is_active: true },
    });
    const roomId = await insertRoom('Casal');
    listRoomTypes.mockResolvedValue([{ id: '7f1fe757-cf66-4878-82fe-ae25920e8d1f', title: 'Suite Casal', count_of_rooms: 6 }]);

    const response = await app.inject({
      method: 'GET',
      url: '/panel/channex/room-types',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      local_rooms: [{ room_id: roomId, room_name: 'Casal', channex_room_type_id: null, channex_rate_plan_id: null }],
      channex_room_types: [{ id: '7f1fe757-cf66-4878-82fe-ae25920e8d1f', title: 'Suite Casal', count_of_rooms: 6 }],
    });
    expect(listRoomTypes).toHaveBeenCalledWith('f6a1bdf1-cef7-4e16-bc4e-a4799510d23f');
  });
});

describe('PUT /panel/channex/room-type-map', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'PUT', url: '/panel/channex/room-type-map', payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it('persists the mapping, visible afterwards through room-types and mapping-status', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();
    const roomId = await insertRoom('Casal');
    await app.inject({
      method: 'PATCH',
      url: '/panel/channex/config',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { property_id: 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f', is_active: true },
    });
    listRoomTypes.mockResolvedValue([{ id: '7f1fe757-cf66-4878-82fe-ae25920e8d1f', title: 'Suite Casal', count_of_rooms: 6 }]);

    const putResponse = await app.inject({
      method: 'PUT',
      url: '/panel/channex/room-type-map',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: {
        room_id: roomId,
        channex_room_type_id: '7f1fe757-cf66-4878-82fe-ae25920e8d1f',
        channex_rate_plan_id: '7e5f22ca-2c19-45a4-a96f-770312dc3d45',
      },
    });
    expect(putResponse.statusCode).toBe(204);

    const roomTypesResponse = await app.inject({
      method: 'GET',
      url: '/panel/channex/room-types',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(roomTypesResponse.json().local_rooms).toEqual([
      {
        room_id: roomId,
        room_name: 'Casal',
        channex_room_type_id: '7f1fe757-cf66-4878-82fe-ae25920e8d1f',
        channex_rate_plan_id: '7e5f22ca-2c19-45a4-a96f-770312dc3d45',
      },
    ]);

    const statusResponse = await app.inject({
      method: 'GET',
      url: '/panel/channex/mapping-status',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(statusResponse.json()).toEqual({ complete: true, total_rooms: 1, mapped_rooms: 1 });
  });

  it('409s when the Channex room type is already claimed by another local room', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();
    const roomA = await insertRoom('Casal');
    const roomB = await insertRoom('Triplo');
    await app.inject({
      method: 'PUT',
      url: '/panel/channex/room-type-map',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomA, channex_room_type_id: '7f1fe757-cf66-4878-82fe-ae25920e8d1f', channex_rate_plan_id: null },
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/panel/channex/room-type-map',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomB, channex_room_type_id: '7f1fe757-cf66-4878-82fe-ae25920e8d1f', channex_rate_plan_id: null },
    });

    expect(response.statusCode).toBe(409);
  });

  it('rejects an invalid channex_room_type_id', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();
    const roomId = await insertRoom('Casal');

    const response = await app.inject({
      method: 'PUT',
      url: '/panel/channex/room-type-map',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, channex_room_type_id: 'not-a-uuid', channex_rate_plan_id: null },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /panel/channex/mapping-status', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/panel/channex/mapping-status' });
    expect(response.statusCode).toBe(401);
  });

  it('is incomplete before any room is mapped', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();
    await insertRoom('Casal');

    const response = await app.inject({
      method: 'GET',
      url: '/panel/channex/mapping-status',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ complete: false, total_rooms: 1, mapped_rooms: 0 });
  });
});

describe('authorization (ota.manage)', () => {
  it('403s a session without ota.manage', async () => {
    const roleId = await createRoleWithPermissions(testDb, []);
    const token = await createSessionCookieForRole(testDb, roleId);
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/panel/channex/config',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(403);
  });

  it('200s a session with ota.manage', async () => {
    const roleId = await createRoleWithPermissions(testDb, ['ota.manage']);
    const token = await createSessionCookieForRole(testDb, roleId);
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/panel/channex/config',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('POST /panel/channex/pull-now', () => {
  it('400s when property_id is not configured', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/channex/pull-now',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(400);
    expect(fetchBookingRevisionsFeed).not.toHaveBeenCalled();
  });

  it('pulls the feed, processes items, and reports how many were acked', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();
    await app.inject({
      method: 'PATCH',
      url: '/panel/channex/config',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { property_id: 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f', is_active: true },
    });

    // A revision that can't be parsed with the fields this fixture provides
    // — proves the wiring end-to-end without depending on the raw Channex
    // shape (see channexPayload.ts's docstring on that shape being unverified).
    fetchBookingRevisionsFeed.mockResolvedValueOnce([{ id: 'feed-1' }]);

    const response = await app.inject({
      method: 'POST',
      url: '/panel/channex/pull-now',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ total_feed_items: 1, processed: 1, acked: 0 });
    expect(ackBookingRevision).not.toHaveBeenCalled();
  });
});

describe('POST /panel/channex/conflicts/:reservationId/retry', () => {
  it('404s for a reservation that does not exist', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/channex/conflicts/999999/retry',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(404);
  });

  it("409s for a reservation that isn't in ota_conflict", async () => {
    const token = await insertSessionCookie();
    const app = buildApp();
    const roomId = await insertRoom('Casal');
    await testDb.insertInto('room_rates').values({ room_id: roomId, occupancy: 2, weekday_cents: 10000, weekend_cents: 15000 }).execute();
    const reservation = await testDb
      .insertInto('reservations')
      .values({
        room_id: roomId,
        check_in: '2026-09-10',
        check_out: '2026-09-13',
        guests: 2,
        status: 'confirmed',
        origin: 'ota',
        total_cents: 30000,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/channex/conflicts/${reservation.id}/retry`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(409);
  });
});
