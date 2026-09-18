/**
 * Integration tests for sdd/move-reservation-dates —
 * POST /panel/reservations/:code/move-dates.
 *
 * Scope: T5-T9 (status gate, overlap, physical conflict, both price paths,
 * min-stay non-blocking warning). Concurrency tests (T10-T11a) and Channex
 * push tests (T12-T13) are separate PRs in this chain — not covered here.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { Kysely, sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import type { DB } from '../../db/types.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelMoveReservationPlugin from '../panelMoveReservation.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { getDueñoRoleId } from '../../test-support/permissionFixtures.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';
import { eachNightUTC } from '../../shared/dateUtils.js';

function buildApp(db: Kysely<DB> = testDb) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelMoveReservationPlugin, { db });
  registerErrorHandler(app);
  return app;
}

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE payments, reservation_nights, reservations, room_rates, room_units, rooms, sessions, users RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

async function insertRoom(
  name: string,
  options: { capacity?: number; defaultMinStay?: number } = {},
): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({
      name,
      capacity: options.capacity ?? 2,
      adults_only: false,
      pets_allowed: false,
      default_min_stay: options.defaultMinStay ?? 1,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  // Every test room needs a rate row: calculatePrice is always invoked
  // (min-stay warning check runs regardless of recalculate_price) and
  // throws if no room_rates row matches the requested occupancy.
  await testDb
    .insertInto('room_rates')
    .values({ room_id: room.id, occupancy: options.capacity ?? 2, weekday_cents: 20000, weekend_cents: 25000 })
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

interface ReservationFixtureOptions {
  roomId: number;
  checkIn: string;
  checkOut: string;
  unitId: number;
  status?: string;
  guests?: number;
  totalCents?: number;
  code?: string;
}

async function insertReservation(options: ReservationFixtureOptions): Promise<{ id: number; code: string }> {
  const nights = eachNightUTC(options.checkIn, options.checkOut);
  const code = options.code ?? `CAT-${randomBytes(4).toString('hex')}`;

  const row = await testDb
    .insertInto('reservations')
    .values({
      room_id: options.roomId,
      room_unit_id: options.unitId,
      check_in: options.checkIn,
      check_out: options.checkOut,
      guests: options.guests ?? 2,
      children: 0,
      babies: 0,
      pets: false,
      status: options.status ?? 'confirmed',
      total_cents: options.totalCents ?? 30000,
      guest_name: 'Maria Gonzalez',
      guest_email: 'maria@example.com',
      guest_phone: '+55 85 90000-0000',
      code,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  if (nights.length > 0) {
    await testDb
      .insertInto('reservation_nights')
      .values(nights.map((night) => ({ reservation_id: row.id, night, room_unit_id: options.unitId })))
      .execute();
  }

  return { id: row.id, code };
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
  const tokenHash = (await import('node:crypto')).createHash('sha256').update(token).digest('hex');
  await testDb
    .insertInto('sessions')
    .values({ user_id: user.id, token_hash: tokenHash, expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) })
    .execute();

  return token;
}

async function nightsOf(reservationId: number): Promise<{ night: string; room_unit_id: number }[]> {
  const rows = await testDb
    .selectFrom('reservation_nights')
    .select([sql<string>`night::text`.as('night'), 'room_unit_id'])
    .where('reservation_id', '=', reservationId)
    .orderBy('night')
    .execute();
  return rows;
}

async function reservationRow(reservationId: number) {
  return testDb
    .selectFrom('reservations')
    .select([
      sql<string>`check_in::text`.as('check_in'),
      sql<string>`check_out::text`.as('check_out'),
      'total_cents',
      'status',
    ])
    .where('id', '=', reservationId)
    .executeTakeFirstOrThrow();
}

beforeEach(async () => {
  await resetDb();
});

describe('POST /panel/reservations/:code/move-dates', () => {
  it('past-dated confirmed reservation keeps full-range edit rights (no date-vs-today comparison)', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unit = await insertUnit(roomId, 'A1');
    const reservation = await insertReservation({
      roomId,
      checkIn: '2020-01-01', // deliberately far in the past
      checkOut: '2020-01-03',
      unitId: unit,
      status: 'confirmed',
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-11-01', check_out: '2026-11-03', recalculate_price: false },
    });

    expect(response.statusCode).toBe(200);
    const row = await reservationRow(reservation.id);
    expect(row.check_in).toBe('2026-11-01');
    expect(row.check_out).toBe('2026-11-03');
    expect(await nightsOf(reservation.id)).toEqual([
      { night: '2026-11-01', room_unit_id: unit },
      { night: '2026-11-02', room_unit_id: unit },
    ]);
  });

  it('409 CHECK_IN_IMMUTABLE when checked_in and check_in changes', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unit = await insertUnit(roomId, 'B1');
    const reservation = await insertReservation({
      roomId,
      checkIn: '2026-10-01',
      checkOut: '2026-10-03',
      unitId: unit,
      status: 'checked_in',
    });
    const app = buildApp();

    const blocked = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-10-02', check_out: '2026-10-04', recalculate_price: false },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('CHECK_IN_IMMUTABLE');
    expect(await nightsOf(reservation.id)).toEqual([
      { night: '2026-10-01', room_unit_id: unit },
      { night: '2026-10-02', room_unit_id: unit },
    ]);

    // NOTE (found while implementing, not in original design/tasks scope):
    // a checked_in reservation extending/shortening ONLY check_out (same
    // check_in) is status-gate-eligible per the spec's "Status-Based Field
    // Gating" requirement, but the design's literal overlap formula
    // (newCheckIn < oldCheckOut && newCheckOut > oldCheckIn) ALWAYS overlaps
    // when check_in is unchanged — so that path is unreachable through this
    // endpoint as specified. Confirmed empirically (a same-check_in,
    // extended-check_out request returns 400 DATE_RANGE_OVERLAPS_CURRENT,
    // not 200) rather than asserted here as a requirement, since neither the
    // spec's scenarios nor tasks T1-T9 test a successful check_out-only
    // change. Flagged for the design/spec owner, not resolved unilaterally.
  });

  it('400 DATE_RANGE_OVERLAPS_CURRENT when the requested range overlaps the current range; nothing written', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unit = await insertUnit(roomId, 'C1');
    const reservation = await insertReservation({
      roomId,
      checkIn: '2026-10-01',
      checkOut: '2026-10-05',
      unitId: unit,
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-10-03', check_out: '2026-10-08', recalculate_price: false },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('DATE_RANGE_OVERLAPS_CURRENT');
    const row = await reservationRow(reservation.id);
    expect(row.check_in).toBe('2026-10-01');
    expect(row.check_out).toBe('2026-10-05');
    expect(await nightsOf(reservation.id)).toHaveLength(4);
  });

  it('409 PHYSICAL_CONFLICT when the unit is occupied in the new range; zero reservation_nights rows inserted or deleted', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unit = await insertUnit(roomId, 'D1');
    const mover = await insertReservation({
      roomId,
      checkIn: '2026-11-01',
      checkOut: '2026-11-03',
      unitId: unit,
    });
    // Occupies the SAME unit for part of the requested new range.
    await insertReservation({
      roomId,
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      unitId: unit,
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${mover.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-11-10', check_out: '2026-11-14', recalculate_price: false },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('PHYSICAL_CONFLICT');

    // Mover's original nights untouched (rolled back, never partially written).
    expect(await nightsOf(mover.id)).toEqual([
      { night: '2026-11-01', room_unit_id: unit },
      { night: '2026-11-02', room_unit_id: unit },
    ]);
    const row = await reservationRow(mover.id);
    expect(row.check_in).toBe('2026-11-01');
    expect(row.check_out).toBe('2026-11-03');
  });

  it('recalculate_price: true updates total_cents to the new-date rate; false leaves it unchanged', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unit = await insertUnit(roomId, 'E1');

    const keepPrice = await insertReservation({
      roomId,
      checkIn: '2026-10-01',
      checkOut: '2026-10-03',
      unitId: unit,
      totalCents: 30000,
    });
    const app = buildApp();

    const kept = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${keepPrice.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-10-15', check_out: '2026-10-17', recalculate_price: false },
    });
    expect(kept.statusCode).toBe(200);
    expect((await reservationRow(keepPrice.id)).total_cents).toBe(30000);

    const recalcUnit = await insertUnit(roomId, 'E2');
    const recalcMove = await insertReservation({
      roomId,
      checkIn: '2026-10-01',
      checkOut: '2026-10-03',
      unitId: recalcUnit,
      totalCents: 30000,
    });
    const recalculated = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${recalcMove.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-10-20', check_out: '2026-10-22', recalculate_price: true },
    });
    expect(recalculated.statusCode).toBe(200);
    // 2 weekday nights @ 20000 = 40000 (weekday rate fixture; exact weekday
    // split isn't asserted, only that it now differs from the frozen price).
    const updated = await reservationRow(recalcMove.id);
    expect(updated.total_cents).not.toBe(30000);
    expect(updated.total_cents).toBeGreaterThan(0);
  });

  it('below-min-stay new range succeeds with a non-blocking BELOW_MIN_STAY warning', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal', { defaultMinStay: 3 });
    const unit = await insertUnit(roomId, 'F1');
    const reservation = await insertReservation({
      roomId,
      checkIn: '2026-10-01',
      checkOut: '2026-10-04', // 3 nights, satisfies min-stay
      unitId: unit,
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-11-01', check_out: '2026-11-03', recalculate_price: false }, // 2 nights, below min-stay 3
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().warnings).toEqual([{ code: 'BELOW_MIN_STAY', message: expect.any(String) }]);
    const row = await reservationRow(reservation.id);
    expect(row.check_in).toBe('2026-11-01');
    expect(row.check_out).toBe('2026-11-03');
    expect(await nightsOf(reservation.id)).toHaveLength(2);
  });
});
