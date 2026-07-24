/**
 * Integration tests for SPEC-modulo-7-gestion-operativa.md § 4 —
 * moveNight/moveStay.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import {
  Kysely,
  PostgresDialect,
  sql,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
} from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, testPool } from '../../db/testClient.js';
import type { DB } from '../../db/types.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelMoveReservationPlugin from '../panelMoveReservation.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';
import { eachNightUTC } from '../../shared/dateUtils.js';

// Same test-only plugin as panelReservationActions.test.ts's concurrency
// test: widens the window between a query's result and the caller receiving
// it, so two genuinely concurrent requests are forced to interleave instead
// of "accidentally" serializing on fast localhost Postgres.
class ArtificialRaceWindowPlugin implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs) {
    return args.node;
  }
  async transformResult(args: PluginTransformResultArgs) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return args.result;
  }
}

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
  await sql`TRUNCATE TABLE payments, reservation_nights, reservations, room_units, rooms, sessions, users RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

async function insertRoom(name: string, options: { capacity?: number; adultsOnly?: boolean } = {}): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({
      name,
      capacity: options.capacity ?? 2,
      adults_only: options.adultsOnly ?? false,
      pets_allowed: false,
      default_min_stay: 1,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
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
  /** One room_unit_id per night (same length as the night count). */
  nightUnitIds: number[];
  status?: string;
  children?: number;
  babies?: number;
  guests?: number;
  code?: string;
}

async function insertReservation(options: ReservationFixtureOptions): Promise<{ id: number; code: string }> {
  const nights = eachNightUTC(options.checkIn, options.checkOut);
  if (nights.length !== options.nightUnitIds.length) {
    throw new Error('nightUnitIds must have one entry per night');
  }
  const code = options.code ?? `CAT-${randomBytes(4).toString('hex')}`;

  const row = await testDb
    .insertInto('reservations')
    .values({
      room_id: options.roomId,
      room_unit_id: options.nightUnitIds[0],
      check_in: options.checkIn,
      check_out: options.checkOut,
      guests: options.guests ?? 2 + (options.children ?? 0),
      children: options.children ?? 0,
      babies: options.babies ?? 0,
      status: options.status ?? 'confirmed',
      total_cents: 30000,
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
      .values(nights.map((night, i) => ({ reservation_id: row.id, night, room_unit_id: options.nightUnitIds[i] })))
      .execute();
  }

  return { id: row.id, code };
}

async function insertSessionCookie(): Promise<string> {
  const user = await testDb
    .insertInto('users')
    .values({ email: 'owner@catavento.test', name: 'Maxi', password_hash: await hashPassword('whatever') })
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

async function nightsOf(reservationId: number): Promise<{ night: string; room_unit_id: number }[]> {
  const rows = await testDb
    .selectFrom('reservation_nights')
    .select([sql<string>`night::text`.as('night'), 'room_unit_id'])
    .where('reservation_id', '=', reservationId)
    .orderBy('night')
    .execute();
  return rows;
}

beforeEach(async () => {
  await resetDb();
});

describe('POST /panel/reservations/:code/move-night', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/NOPE/move-night',
      payload: { night: '2026-09-01', toUnitId: 1 },
    });
    expect(response.statusCode).toBe(401);
  });

  it('404 when the reservation code does not exist', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/NOPE/move-night',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { night: '2026-09-01', toUnitId: 1 },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('RESERVATION_NOT_FOUND');
  });

  it('409 RESERVATION_NOT_MOVABLE when the reservation is checked_out', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unitA = await insertUnit(roomId, 'A1');
    const unitB = await insertUnit(roomId, 'A2');
    const reservation = await insertReservation({
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-03',
      nightUnitIds: [unitA, unitA],
      status: 'checked_out',
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-night`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { night: '2026-09-01', toUnitId: unitB },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('RESERVATION_NOT_MOVABLE');
  });

  it('moves a single night, leaving the reservation fragmented across two units', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    const unitA = await insertUnit(roomId, 'B1');
    const unitB = await insertUnit(roomId, 'B2');
    const reservation = await insertReservation({
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-04',
      nightUnitIds: [unitA, unitA, unitA],
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-night`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { night: '2026-09-02', toUnitId: unitB },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().units).toEqual([
      { night: '2026-09-01', unit_label: 'B1' },
      { night: '2026-09-02', unit_label: 'B2' },
      { night: '2026-09-03', unit_label: 'B1' },
    ]);

    const rows = await nightsOf(reservation.id);
    expect(rows).toEqual([
      { night: '2026-09-01', room_unit_id: unitA },
      { night: '2026-09-02', room_unit_id: unitB },
      { night: '2026-09-03', room_unit_id: unitA },
    ]);
  });

  it('409 PHYSICAL_CONFLICT when the destination unit is occupied that night — no force_commercial escape hatch', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unitA = await insertUnit(roomId, 'C1');
    const unitB = await insertUnit(roomId, 'C2');
    const mover = await insertReservation({
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-03',
      nightUnitIds: [unitA, unitA],
    });
    // Occupies unitB on 2026-09-01, blocking the move.
    await insertReservation({
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-02',
      nightUnitIds: [unitB],
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${mover.code}/move-night`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { night: '2026-09-01', toUnitId: unitB, force_commercial: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('PHYSICAL_CONFLICT');

    const rows = await nightsOf(mover.id);
    expect(rows[0]).toEqual({ night: '2026-09-01', room_unit_id: unitA }); // untouched
  });

  it('422 COMMERCIAL_WARNING when destination capacity is too small, nothing written; 200 after retry with force_commercial', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal', { capacity: 2 });
    const smallUnit = await insertUnit(roomId, 'D1');
    const bigRoomId = await insertRoom('Suite', { capacity: 4 });
    const bigUnit = await insertUnit(bigRoomId, 'E1');
    const reservation = await insertReservation({
      roomId: bigRoomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-02',
      nightUnitIds: [bigUnit],
      guests: 3,
    });
    const app = buildApp();

    const warned = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-night`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { night: '2026-09-01', toUnitId: smallUnit },
    });
    expect(warned.statusCode).toBe(422);
    expect(warned.json().error).toBe('COMMERCIAL_WARNING');
    expect(warned.json().warnings).toEqual([
      { code: 'CAPACITY_EXCEEDED', message: 'guests exceeds room capacity (2)' },
    ]);
    expect(await nightsOf(reservation.id)).toEqual([{ night: '2026-09-01', room_unit_id: bigUnit }]);

    const forced = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-night`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { night: '2026-09-01', toUnitId: smallUnit, force_commercial: true },
    });
    expect(forced.statusCode).toBe(200);
    expect(await nightsOf(reservation.id)).toEqual([{ night: '2026-09-01', room_unit_id: smallUnit }]);
  });

  it('force_commercial NEVER overrides a physical conflict, even combined with a commercial violation on the same move', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal', { capacity: 2 });
    const targetUnit = await insertUnit(roomId, 'F1');
    const mover = await insertReservation({
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-02',
      nightUnitIds: [await insertUnit(roomId, 'F0')],
      guests: 3, // also violates capacity against Casal(2) — commercial AND physical both fail
    });
    // Occupy the target unit for that night with someone else.
    await insertReservation({
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-02',
      nightUnitIds: [targetUnit],
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${mover.code}/move-night`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { night: '2026-09-01', toUnitId: targetUnit, force_commercial: true },
    });

    // Physical conflict is checked before commercial and wins regardless of the flag.
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('PHYSICAL_CONFLICT');
  });
});

describe('POST /panel/reservations/:code/move-stay', () => {
  it('moves every night atomically to the destination unit', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unitA = await insertUnit(roomId, 'G1');
    const unitB = await insertUnit(roomId, 'G2');
    const reservation = await insertReservation({
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-04',
      nightUnitIds: [unitA, unitA, unitA],
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-stay`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { toUnitId: unitB },
    });

    expect(response.statusCode).toBe(200);
    const rows = await nightsOf(reservation.id);
    expect(rows.every((r) => r.room_unit_id === unitB)).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it('all-or-nothing: if ANY night of the destination is occupied, no night moves', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unitA = await insertUnit(roomId, 'H1');
    const unitB = await insertUnit(roomId, 'H2');
    const mover = await insertReservation({
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-04',
      nightUnitIds: [unitA, unitA, unitA],
    });
    // Blocks only the middle night of unitB.
    await insertReservation({
      roomId,
      checkIn: '2026-09-02',
      checkOut: '2026-09-03',
      nightUnitIds: [unitB],
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${mover.code}/move-stay`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { toUnitId: unitB },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('PHYSICAL_CONFLICT');

    const rows = await nightsOf(mover.id);
    expect(rows.every((r) => r.room_unit_id === unitA)).toBe(true); // fully untouched
  });
});

describe('GET /panel/reservations/:code/move-options', () => {
  it('lists active units, flagging which are free for every night of the stay', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unitA = await insertUnit(roomId, 'I1');
    const unitB = await insertUnit(roomId, 'I2');
    const reservation = await insertReservation({
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-03',
      nightUnitIds: [unitA, unitA],
    });
    // Occupies unitB for one of the two nights.
    await insertReservation({
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-02',
      nightUnitIds: [unitB],
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: `/panel/reservations/${reservation.code}/move-options`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.nights).toEqual(['2026-09-01', '2026-09-02']);
    const unitBOption = body.units.find((u: { unit_id: number }) => u.unit_id === unitB);
    expect(unitBOption.free_for_all_nights).toBe(false);
    expect(unitBOption.occupied_nights).toEqual(['2026-09-01']);
    // unitA is occupied by the reservation's OWN nights, which must not count as a conflict against itself.
    const unitAOption = body.units.find((u: { unit_id: number }) => u.unit_id === unitA);
    expect(unitAOption.free_for_all_nights).toBe(true);
  });
});

describe('concurrency: two DIFFERENT reservations moving into the same free unit-night', () => {
  // A bare Promise.all over HTTP tends to fully serialize by luck on fast
  // localhost Postgres (same finding as panelReservationActions.test.ts's
  // idempotency race) — this smoke test keeps that real-world shape, the
  // deterministic proof is the test below it.
  it('smoke: one succeeds (200), the other is rejected (409), never both 200 and never a raw 500', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const sourceA = await insertUnit(roomId, 'J1');
    const sourceB = await insertUnit(roomId, 'J2');
    const targetUnit = await insertUnit(roomId, 'J3');
    const reservationA = await insertReservation({
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-02',
      nightUnitIds: [sourceA],
    });
    const reservationB = await insertReservation({
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-02',
      nightUnitIds: [sourceB],
    });
    const app = buildApp();

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/panel/reservations/${reservationA.code}/move-night`,
        cookies: { [SESSION_COOKIE_NAME]: token },
        payload: { night: '2026-09-01', toUnitId: targetUnit },
      }),
      app.inject({
        method: 'POST',
        url: `/panel/reservations/${reservationB.code}/move-night`,
        cookies: { [SESSION_COOKIE_NAME]: token },
        payload: { night: '2026-09-01', toUnitId: targetUnit },
      }),
    ]);

    const statusCodes = [first.statusCode, second.statusCode].sort();
    expect(statusCodes).toEqual([200, 409]);

    const rows = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('room_unit_id', '=', targetUnit)
      .where('night', '=', sql<Date>`'2026-09-01'::date`)
      .execute();
    expect(rows).toHaveLength(1); // the UNIQUE constraint's job — never two winners
  });

  // DETERMINISTIC version, through the REAL moveNight code path. Forces the
  // exact interleaving (both requests pass the pre-write assertNightsFree
  // check before either has committed its insert) by widening the window
  // with an artificial delay after every query result — same technique as
  // panelReservationActions.test.ts's ArtificialRaceWindowPlugin.
  //
  // Verification per server/CLAUDE.md's concurrency-test rule (checked by
  // hand, not left as a claim): with `isUnitNightUniqueViolation` handling
  // removed from insertNightOrThrowConflict in moveReservation.ts (so the
  // 23505 propagates uncaught), this exact test goes from
  // `expect(statusCodes).toEqual([200, 409])` to one request returning a raw
  // 500 instead of 409 — confirming the catch is what this test exercises,
  // not the advisory lock (which only serializes moves of the SAME
  // reservation, not these two DIFFERENT ones — see moveReservation.ts's
  // module doc comment).
  it('DETERMINISTIC: with the race window artificially widened, still exactly one 200 and one 409, never a raw 500', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const sourceA = await insertUnit(roomId, 'K1');
    const sourceB = await insertUnit(roomId, 'K2');
    const targetUnit = await insertUnit(roomId, 'K3');
    const reservationA = await insertReservation({
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-02',
      nightUnitIds: [sourceA],
    });
    const reservationB = await insertReservation({
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-02',
      nightUnitIds: [sourceB],
    });
    const delayedDb = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: testPool }),
      plugins: [new ArtificialRaceWindowPlugin()],
    });
    const app = buildApp(delayedDb);

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/panel/reservations/${reservationA.code}/move-night`,
        cookies: { [SESSION_COOKIE_NAME]: token },
        payload: { night: '2026-09-01', toUnitId: targetUnit },
      }),
      app.inject({
        method: 'POST',
        url: `/panel/reservations/${reservationB.code}/move-night`,
        cookies: { [SESSION_COOKIE_NAME]: token },
        payload: { night: '2026-09-01', toUnitId: targetUnit },
      }),
    ]);

    const statusCodes = [first.statusCode, second.statusCode].sort();
    expect(statusCodes).toEqual([200, 409]);

    const rows = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('room_unit_id', '=', targetUnit)
      .where('night', '=', sql<Date>`'2026-09-01'::date`)
      .execute();
    expect(rows).toHaveLength(1);
  }, 15000);
  // Explicit timeout: a single moveNight call through delayedDb pays the
  // 120ms artificial delay on ~9 sequential queries (3 pre-lock reads +
  // lock + status recheck + delete + insert + 2 consistency-check reads),
  // ~1.1s of pure artificial delay alone before real round-trip time or any
  // lock-wait for the losing request's blocked insert. That is close enough
  // to Vitest's 5000ms default that real machine load (this suite run
  // repeatedly, back-to-back, for over 40 minutes during the investigation
  // that added this comment) pushed it over — confirmed by the failure being
  // a bare "Test timed out in 5000ms", not a DB error, and by a parallel
  // pg_stat_activity/pool diagnostic showing no leaked connection or
  // idle-in-transaction session at fault. 7B's equivalent test
  // (panelReservationActions.test.ts) only pays that delay on ~2 queries and
  // never needed this — this one legitimately does more work per call.
});
