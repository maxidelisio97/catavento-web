/**
 * Integration tests for SPEC-modulo-7-gestion-operativa.md § 4 —
 * moveNight/moveStay.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, testPool } from '../../db/testClient.js';
import type { DB } from '../../db/types.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelMoveReservationPlugin from '../panelMoveReservation.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';
import { eachNightUTC } from '../../shared/dateUtils.js';
import { createQueryBarrierPlugin, createQueryStartSignal, rawSqlContains, selectReferencesTable } from '../../test-support/queryBarrier.js';
import { moveNight } from '../../panel/moveReservation.js';

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

async function insertRoom(
  name: string,
  options: { capacity?: number; adultsOnly?: boolean; petsAllowed?: boolean } = {},
): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({
      name,
      capacity: options.capacity ?? 2,
      adults_only: options.adultsOnly ?? false,
      pets_allowed: options.petsAllowed ?? false,
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
  pets?: boolean;
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
      pets: options.pets ?? false,
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

  it('409 ADULTS_ONLY_ROOM when destination is adults-only and the reservation has children — no force_commercial escape hatch (7D hardening, was skippable in 7C)', async () => {
    const token = await insertSessionCookie();
    const familyRoomId = await insertRoom('Triplo', { capacity: 3 });
    const originUnit = await insertUnit(familyRoomId, 'G0');
    const casalId = await insertRoom('Casal', { adultsOnly: true });
    const casalUnit = await insertUnit(casalId, 'G1');
    const reservation = await insertReservation({
      roomId: familyRoomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-02',
      nightUnitIds: [originUnit],
      children: 1,
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-night`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { night: '2026-09-01', toUnitId: casalUnit, force_commercial: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('ADULTS_ONLY_ROOM');
    expect(await nightsOf(reservation.id)).toEqual([{ night: '2026-09-01', room_unit_id: originUnit }]);
  });

  it('409 PETS_NOT_ALLOWED when destination does not allow pets and the reservation has a pet — no force_commercial escape hatch', async () => {
    const token = await insertSessionCookie();
    const tripleRoomId = await insertRoom('Triplo', { capacity: 3, petsAllowed: true });
    const originUnit = await insertUnit(tripleRoomId, 'H0');
    const casalId = await insertRoom('Casal', { petsAllowed: false });
    const casalUnit = await insertUnit(casalId, 'H1');
    const reservation = await insertReservation({
      roomId: tripleRoomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-02',
      nightUnitIds: [originUnit],
      pets: true,
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-night`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { night: '2026-09-01', toUnitId: casalUnit, force_commercial: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('PETS_NOT_ALLOWED');
    expect(await nightsOf(reservation.id)).toEqual([{ night: '2026-09-01', room_unit_id: originUnit }]);
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

  it('409 PETS_NOT_ALLOWED — hard rule, no force_commercial escape hatch, nothing moves', async () => {
    const token = await insertSessionCookie();
    const tripleRoomId = await insertRoom('Triplo', { capacity: 3, petsAllowed: true });
    const originUnit = await insertUnit(tripleRoomId, 'H3');
    const casalId = await insertRoom('Casal', { petsAllowed: false });
    const casalUnit = await insertUnit(casalId, 'H4');
    const reservation = await insertReservation({
      roomId: tripleRoomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-03',
      nightUnitIds: [originUnit, originUnit],
      pets: true,
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-stay`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { toUnitId: casalUnit, force_commercial: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('PETS_NOT_ALLOWED');
    expect((await nightsOf(reservation.id)).every((r) => r.room_unit_id === originUnit)).toBe(true);
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
  // check before either has committed its insert) with a rendezvous
  // barrier targeted at that exact query, instead of a fixed delay after
  // every query (the old ArtificialRaceWindowPlugin technique) — see
  // server/src/test-support/queryBarrier.ts's doc comment for why. The
  // barrier's `match` fingerprints assertNightsFree's SELECT specifically
  // (the only SELECT in moveNight's path that joins reservation_nights AND
  // reservations — fetchReservationByCode and the post-lock status re-read
  // both select from reservations alone, fetchDestinationUnit joins
  // room_units+rooms, and nightsOf() in this file runs on the plain testDb,
  // never through this plugin at all).
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
  it('DETERMINISTIC: with a rendezvous barrier on the pre-write check, still exactly one 200 and one 409, never a raw 500', async () => {
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
    // Recorded, not just trusted: proves the barrier fired exactly twice —
    // once per request — on the intended query, and never on a neighbor
    // (fetchReservationByCode/fetchDestinationUnit/the post-lock status
    // re-read don't join both tables, so they never push here).
    const barrierHits: number[] = [];
    const barrieredDb = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: testPool }),
      plugins: [
        createQueryBarrierPlugin({
          arity: 2,
          match: (node) => {
            const isTarget = selectReferencesTable(node, 'reservation_nights') && selectReferencesTable(node, 'reservations');
            if (isTarget) barrierHits.push(Date.now());
            return isTarget;
          },
        }),
      ],
    });
    const app = buildApp(barrieredDb);

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

    // Both requests reached assertNightsFree's SELECT — the exact
    // pre-write check the barrier targets, and the only query in moveNight's
    // path that joins reservation_nights with reservations.
    expect(barrierHits).toHaveLength(2);

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
});

describe('concurrency: two moves of the SAME reservation share the SAME advisory-lock key', () => {
  // DETERMINISTIC, same technique as panelReservationActions.test.ts's
  // checkIn-vs-cancel test: holds the exact advisory-lock key moveNight uses
  // on a raw connection (simulating a first move already in flight, lock
  // acquired, not yet committed) and calls the REAL moveNight service
  // function concurrently, asserting it genuinely blocks — not a uniform
  // delay that hopes for an interleaving.
  //
  // Why this scenario specifically (not just "any two concurrent moves"):
  // moving the SAME night to two DIFFERENT destination units on the SAME
  // reservation is the one case the (room_unit_id, night) UNIQUE constraint
  // (reservation_nights_unit_night_unique) does NOT catch — unitB and unitC
  // are different keys there. Verified by hand (see the guard-removal check
  // below): WITHOUT the lock, the second move's INSERT instead collides with
  // a DIFFERENT, narrower constraint — reservation_nights_reservation_night_unique,
  // UNIQUE(reservation_id, night) — because the first move's row for this
  // reservation+night hasn't been deleted yet from the second move's point of
  // view. insertNightOrThrowConflict only recognizes the unit_night
  // violation (isUnitNightUniqueViolation matches on the constraint name
  // containing "unit_night"), so this one propagates as a raw, unhandled
  // 23505 instead of a clean result. The lock prevents this by forcing full
  // serialization: the second move's DELETE removes the first move's
  // just-committed row before inserting its own, so the insert never
  // collides with anything — last write wins, cleanly, never a raw error.
  it('DETERMINISTIC: moveNight blocks on the SAME advisory-lock key a concurrent move of the SAME reservation holds, and leaves exactly one row for the night — never both destinations', async () => {
    const roomId = await insertRoom('Casal');
    const unitA = await insertUnit(roomId, 'M1');
    const unitB = await insertUnit(roomId, 'M2');
    const unitC = await insertUnit(roomId, 'M3');
    const reservation = await insertReservation({
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-02',
      nightUnitIds: [unitA],
    });

    // Warm the pool with two genuinely concurrent queries first — same
    // rationale as panelReservationActions.test.ts's checkIn test: on a cold
    // connection the first query's TCP+auth handshake alone can cost
    // 300-400ms on this machine, which would look like "blocked on the lock"
    // even with no lock involved at all.
    await Promise.all([
      testDb.selectFrom('reservations').select('id').limit(1).execute(),
      testDb.selectFrom('reservations').select('id').limit(1).execute(),
    ]);

    // Raw connection holding the SAME lock key moveNight would use for this
    // reservation, simulating a first move (night -> unitB) that has
    // acquired the lock but not yet committed. ENTIRE lifecycle in
    // try/finally — not just the final commit — so a failure acquiring the
    // lock itself can never leak the connection while still holding it.
    // Found necessary from a real full-suite run: a fixed-margin version of
    // this pattern, with only the commit protected, produced a catastrophic
    // cascade (68/227 tests) under sustained load, consistent with an
    // orphaned advisory lock on a low reservation id (ids restart at 1 every
    // test) blocking most of the rest of the suite — see
    // server/CLAUDE.md's concurrency-test lesson on this.
    const holder = await testPool.connect();
    const { plugin: startSignalPlugin, started } = createQueryStartSignal({
      match: (node) => rawSqlContains(node, 'pg_advisory_xact_lock'),
    });
    const measuredDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: testPool }), plugins: [startSignalPlugin] });

    let movePromise!: Promise<void>;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1)', [reservation.id]);

      movePromise = moveNight(measuredDb, { code: reservation.code, night: '2026-09-01', toUnitId: unitC });
      // Never let this leak as an unhandled rejection if the holder's own
      // setup below throws before we reach the real `await movePromise` —
      // otherwise it stays orphaned against a lock the holder never
      // released, and rejects later, attributed to whatever test happens to
      // be running at that point (found via a real full-suite cascade).
      movePromise.catch(() => {});

      // Event-based, not a guessed setTimeout margin: waits for moveNight
      // to actually SEND its own lock-acquisition query. A fixed ms guess
      // here was found fragile under load in the payment lock tests (2/5
      // full-suite runs failed on the equivalent assertion) — see
      // server/CLAUDE.md's concurrency-test lesson on this.
      await started;

      // Finish what the first move does, still holding the lock: swap the
      // night from unitA to unitB.
      await holder.query(
        `DELETE FROM reservation_nights WHERE reservation_id = $1 AND night = '2026-09-01'::date`,
        [reservation.id],
      );
      await holder.query(
        `INSERT INTO reservation_nights (reservation_id, night, room_unit_id) VALUES ($1, '2026-09-01'::date, $2)`,
        [reservation.id, unitB],
      );
      await holder.query('COMMIT');
    } catch (err) {
      // pg_advisory_xact_lock is transaction-scoped: without an explicit
      // ROLLBACK here, a failure between BEGIN and COMMIT leaves the
      // transaction (and the lock inside it) open when release() below
      // returns the connection to the pool — verified by hand: the next
      // checkout of that same connection inherits an aborted transaction
      // (25P02) and the lock is never actually free. release() alone does
      // NOT roll back an open transaction.
      await holder.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      holder.release();
    }

    // Now unblocked: the second move re-reads fresh state under its own
    // lock, deletes unitB's row (the first move's, now committed) and
    // inserts its own — never seeing a stale pre-lock snapshot.
    await expect(movePromise).resolves.toBeUndefined();

    const rows = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .execute();
    expect(rows).toHaveLength(1); // never both unitB and unitC at once
    expect(rows[0]!.room_unit_id).toBe(unitC); // last write wins
  });
});
