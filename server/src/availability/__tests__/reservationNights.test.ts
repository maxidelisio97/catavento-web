/**
 * Integration tests for SPEC-modulo-6-panel-base.md's "ENTREGA 6A —
 * Asignación de unidad por noche": the reservation_nights table, the date
 * convention (checkout never generates a row), the lazy sweep
 * (sweepStaleReservationNights.ts) that frees stale rows at write time, and
 * the consistency check (checkReservationNightsConsistency.ts).
 *
 * Mirrors roomUnits.test.ts's fixture conventions (local rooms/units per
 * test, not relying on the migration's own seed surviving between files).
 */
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, testPool } from '../../db/testClient.js';
import { createReservation, NoAvailabilityError } from '../createReservation.js';
import { checkReservationNightsConsistency } from '../checkReservationNightsConsistency.js';
import { eachNightUTC } from '../../shared/dateUtils.js';

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE reservation_nights, reservations, rate_overrides, room_rates, rooms RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

async function insertRoom(name: string, capacity: number): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({ name, capacity, pets_allowed: false, default_min_stay: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();

  await testDb
    .insertInto('room_rates')
    .values({ room_id: room.id, occupancy: capacity, weekday_cents: 10000, weekend_cents: 15000 })
    .execute();

  return room.id;
}

async function insertUnits(roomId: number, labels: string[]): Promise<number[]> {
  const rows = await testDb
    .insertInto('room_units')
    .values(labels.map((label) => ({ room_id: roomId, label })))
    .returning('id')
    .execute();
  return rows.map((r) => r.id);
}

interface StaleReservationOptions {
  roomId: number;
  roomUnitId: number;
  checkIn: string;
  checkOut: string;
  status: 'cancelled' | 'pending_payment';
  expiresAt?: Date | null;
}

/** Inserts a reservation + its reservation_nights rows directly, bypassing
 * createReservation — used to simulate a hold that already expired (or was
 * cancelled) before the sweep ever ran, i.e. exactly the "stale rows left
 * behind" starting state the lazy sweep exists to clean up. */
async function insertStaleReservation(options: StaleReservationOptions): Promise<number> {
  const row = await testDb
    .insertInto('reservations')
    .values({
      room_id: options.roomId,
      room_unit_id: options.roomUnitId,
      check_in: options.checkIn,
      check_out: options.checkOut,
      guests: 2,
      status: options.status,
      expires_at: options.expiresAt ?? null,
      total_cents: 10000,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const nights = eachNightUTC(options.checkIn, options.checkOut);
  await testDb
    .insertInto('reservation_nights')
    .values(nights.map((night) => ({ reservation_id: row.id, night, room_unit_id: options.roomUnitId })))
    .execute();

  return row.id;
}

beforeEach(async () => {
  await resetDb();
});

describe('reservation_nights — row shape per stay', () => {
  it('a 3-night reservation produces exactly 3 rows, same unit, correct nights, none on checkout', async () => {
    const casalId = await insertRoom('Casal', 2);
    await insertUnits(casalId, ['101']);

    const result = await createReservation(testDb, {
      roomId: casalId,
      checkIn: '2026-09-10',
      checkOut: '2026-09-13',
      guests: 2,
    });

    const rows = await testDb
      .selectFrom('reservation_nights')
      .select([sql<string>`night::text`.as('night'), 'room_unit_id'])
      .where('reservation_id', '=', result.id)
      .orderBy('night')
      .execute();

    expect(rows.map((r) => r.night)).toEqual(['2026-09-10', '2026-09-11', '2026-09-12']);
    expect(rows.every((r) => r.room_unit_id === rows[0].room_unit_id)).toBe(true);
    expect(rows.some((r) => r.night === '2026-09-13')).toBe(false);
  });

  it('a 1-night reservation produces exactly 1 row', async () => {
    const casalId = await insertRoom('Casal', 2);
    await insertUnits(casalId, ['101']);

    const result = await createReservation(testDb, {
      roomId: casalId,
      checkIn: '2026-09-10',
      checkOut: '2026-09-11',
      guests: 2,
    });

    const rows = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', result.id)
      .execute();

    expect(rows).toHaveLength(1);
  });

  it('two contiguous reservations on the same unit coexist without conflict — checkout day belongs only to the second', async () => {
    const casalId = await insertRoom('Casal', 2);
    await insertUnits(casalId, ['101']);

    const first = await createReservation(testDb, {
      roomId: casalId,
      checkIn: '2026-09-10',
      checkOut: '2026-09-12',
      guests: 2,
    });
    const second = await createReservation(testDb, {
      roomId: casalId,
      checkIn: '2026-09-12',
      checkOut: '2026-09-14',
      guests: 2,
    });

    const nightOwner = await testDb
      .selectFrom('reservation_nights')
      .select([sql<string>`night::text`.as('night'), 'reservation_id'])
      .where('night', '=', sql<Date>`'2026-09-12'::date`)
      .execute();

    expect(nightOwner).toHaveLength(1);
    expect(nightOwner[0].reservation_id).toBe(second.id);

    const firstNights = await testDb
      .selectFrom('reservation_nights')
      .select(sql<string>`night::text`.as('night'))
      .where('reservation_id', '=', first.id)
      .execute();
    expect(firstNights.map((n) => n.night).sort()).toEqual(['2026-09-10', '2026-09-11']);
  });
});

describe('reservation_nights — lazy sweep frees stale rows at write time', () => {
  it('an expired pending_payment occupying the unit gets swept when a new reservation targets the same nights, and the new one is created', async () => {
    const casalId = await insertRoom('Casal', 2);
    const [unitA] = await insertUnits(casalId, ['101']);

    const stale = await insertStaleReservation({
      roomId: casalId,
      roomUnitId: unitA,
      checkIn: '2026-09-10',
      checkOut: '2026-09-12',
      status: 'pending_payment',
      expiresAt: new Date(Date.now() - 60_000),
    });

    // Sanity: the stale rows really are sitting there before the sweep runs.
    const before = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', stale)
      .execute();
    expect(before).toHaveLength(2);

    const result = await createReservation(testDb, {
      roomId: casalId,
      checkIn: '2026-09-10',
      checkOut: '2026-09-12',
      guests: 2,
    });

    const staleRowsAfter = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', stale)
      .execute();
    expect(staleRowsAfter).toHaveLength(0);

    const newRows = await testDb
      .selectFrom('reservation_nights')
      .select('room_unit_id')
      .where('reservation_id', '=', result.id)
      .execute();
    expect(newRows).toHaveLength(2);
    expect(newRows.every((r) => r.room_unit_id === unitA)).toBe(true);
  });

  it('a cancelled reservation occupying the unit gets swept when a new reservation targets the same nights, and the new one is created', async () => {
    const casalId = await insertRoom('Casal', 2);
    const [unitA] = await insertUnits(casalId, ['101']);

    const stale = await insertStaleReservation({
      roomId: casalId,
      roomUnitId: unitA,
      checkIn: '2026-09-10',
      checkOut: '2026-09-12',
      status: 'cancelled',
    });

    const result = await createReservation(testDb, {
      roomId: casalId,
      checkIn: '2026-09-10',
      checkOut: '2026-09-12',
      guests: 2,
    });

    const staleRowsAfter = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', stale)
      .execute();
    expect(staleRowsAfter).toHaveLength(0);

    const newRows = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', result.id)
      .execute();
    expect(newRows).toHaveLength(2);
  });
});

describe('reservation_nights — concurrency', () => {
  it('with 1 unit left, exactly one of two simultaneous creations wins, never two rows for the same unit and night', async () => {
    const casalId = await insertRoom('Casal', 2);
    const [unitA] = await insertUnits(casalId, ['101']);

    const attempt = () =>
      createReservation(testDb, { roomId: casalId, checkIn: '2026-10-01', checkOut: '2026-10-03', guests: 2 });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(NoAvailabilityError);
    expect(testPool.totalCount).toBeGreaterThanOrEqual(2);

    const rows = await testDb
      .selectFrom('reservation_nights')
      .select([sql<string>`night::text`.as('night'), 'room_unit_id'])
      .where('room_unit_id', '=', unitA)
      .execute();

    // 2 nights from the single winning reservation, no duplicates.
    expect(rows).toHaveLength(2);
    const uniqueNights = new Set(rows.map((r) => r.night));
    expect(uniqueNights.size).toBe(2);
  });
});

describe('reservation_nights — consistency check', () => {
  it('reports zero inconsistencies after a normal mix of active, expired, and cancelled reservations', async () => {
    const casalId = await insertRoom('Casal', 2);
    const [unitA, unitB] = await insertUnits(casalId, ['101', '102']);

    await createReservation(testDb, { roomId: casalId, checkIn: '2026-09-10', checkOut: '2026-09-13', guests: 2 });
    await insertStaleReservation({
      roomId: casalId,
      roomUnitId: unitB,
      checkIn: '2026-09-15',
      checkOut: '2026-09-16',
      status: 'cancelled',
    });

    const inconsistencies = await checkReservationNightsConsistency(testDb);
    expect(inconsistencies).toEqual([]);
  });
});
