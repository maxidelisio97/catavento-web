/**
 * Integration tests for `GET /panel/rooms/:roomId/free-units` — design:
 * nova-reserva-panel, D5-D9. Composes `fetchRoomStayData` + `findFreeUnits`
 * only (D6 — no commercial gates), returns ALL active units with a `free`
 * boolean (D5 — not free-only), and must never write (D7 — no sweep).
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { Kysely, PostgresDialect, sql, type RootOperationNode } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb, testPool } from '../../db/testClient.js';
import type { DB } from '../../db/types.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelRoomFreeUnitsPlugin from '../panelRoomFreeUnits.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { createRoleWithPermissions, createSessionCookieForRole, getDueñoRoleId } from '../../test-support/permissionFixtures.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';
import * as sweepModule from '../../availability/sweepStaleReservationNights.js';

function buildApp(db: Kysely<DB> = testDb) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelRoomFreeUnitsPlugin, { db });
  registerErrorHandler(app);
  return app;
}

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE payments, reservation_nights, reservations, room_units, rooms, settings, sessions, users RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
  await testDb
    .insertInto('settings')
    .values([
      { key: 'deposit_percent', value: '50' },
      { key: 'hold_minutes', value: '30' },
      { key: 'pet_fee_cents', value: '3000' },
    ])
    .execute();
}

interface RoomOptions {
  capacity?: number;
}

async function insertRoom(name: string, options: RoomOptions = {}): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({
      name,
      capacity: options.capacity ?? 2,
      adults_only: false,
      pets_allowed: false,
      default_min_stay: 1,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await testDb
    .insertInto('room_rates')
    .values({ room_id: room.id, occupancy: options.capacity ?? 2, weekday_cents: 10000, weekend_cents: 15000 })
    .execute();

  return room.id;
}

async function insertUnit(roomId: number, label: string): Promise<number> {
  const unit = await testDb
    .insertInto('room_units')
    .values({ room_id: roomId, label })
    .returning('id')
    .executeTakeFirstOrThrow();
  return unit.id;
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

const CHECK_IN = '2026-10-05';
const CHECK_OUT = '2026-10-07';

beforeEach(async () => {
  await resetDb();
  vi.restoreAllMocks();
});

describe('GET /panel/rooms/:roomId/free-units', () => {
  it('401s without a session cookie', async () => {
    const roomId = await insertRoom('Triplo', { capacity: 3 });
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/panel/rooms/${roomId}/free-units?check_in=${CHECK_IN}&check_out=${CHECK_OUT}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('403s a session without reservations.create_manual', async () => {
    const roomId = await insertRoom('Triplo', { capacity: 3 });
    const roleId = await createRoleWithPermissions(testDb, []);
    const token = await createSessionCookieForRole(testDb, roleId);
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/panel/rooms/${roomId}/free-units?check_in=${CHECK_IN}&check_out=${CHECK_OUT}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(403);
  });

  it('200s with ALL active units (not just free ones), sorted by label, marking each with a free boolean', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo', { capacity: 3 });
    const unitC = await insertUnit(roomId, 'T3');
    const unitA = await insertUnit(roomId, 'T1');
    const unitB = await insertUnit(roomId, 'T2');

    // Occupy T1 (unitA) for the requested range via a real reservation +
    // reservation_nights row — the endpoint composes fetchRoomStayData +
    // findFreeUnits, which read from reservation_nights (module 6A).
    const reservation = await testDb
      .insertInto('reservations')
      .values({
        room_id: roomId,
        room_unit_id: unitA,
        code: 'ABC123',
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        guests: 2,
        guest_name: 'Occupant',
        status: 'confirmed',
        total_cents: 20000,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await testDb
      .insertInto('reservation_nights')
      .values({ reservation_id: reservation.id, room_unit_id: unitA, night: '2026-10-05' })
      .execute();

    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/panel/rooms/${roomId}/free-units?check_in=${CHECK_IN}&check_out=${CHECK_OUT}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.room_id).toBe(roomId);
    expect(body.check_in).toBe(CHECK_IN);
    expect(body.check_out).toBe(CHECK_OUT);
    expect(body.units).toEqual([
      { id: unitA, label: 'T1', free: false },
      { id: unitB, label: 'T2', free: true },
      { id: unitC, label: 'T3', free: true },
    ]);
  });

  it('404s ROOM_NOT_FOUND for a room that does not exist', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/panel/rooms/999999/free-units?check_in=${CHECK_IN}&check_out=${CHECK_OUT}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'ROOM_NOT_FOUND' });
  });

  it('400s INVALID_DATE_RANGE for a check_in that is not a real calendar date', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo', { capacity: 3 });
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/panel/rooms/${roomId}/free-units?check_in=2026-13-45&check_out=${CHECK_OUT}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'INVALID_DATE_RANGE' });
  });

  it('400s INVALID_DATE_RANGE when check_out <= check_in', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo', { capacity: 3 });
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/panel/rooms/${roomId}/free-units?check_in=${CHECK_OUT}&check_out=${CHECK_IN}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'INVALID_DATE_RANGE' });
  });

  it('T2.3: never calls sweepStaleReservationNights — a GET must not write', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo', { capacity: 3 });
    await insertUnit(roomId, 'T1');
    const sweepSpy = vi.spyOn(sweepModule, 'sweepStaleReservationNights');

    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/panel/rooms/${roomId}/free-units?check_in=${CHECK_IN}&check_out=${CHECK_OUT}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(sweepSpy).not.toHaveBeenCalled();
  });
});
