/**
 * Integration tests for SPEC-modulo-5-unidades-fisicas.md's per-unit
 * assignment and anti-overbooking. These use rooms named 'Casal'/'Triplo'/
 * 'Quádruplo' (mirroring the real inventory) built via local fixtures here
 * rather than depending on the migration's own seed step surviving — every
 * other test file in this suite truncates the whole `rooms` table between
 * cases, so persisted seed data can't be relied on across files. The
 * migration's seed step itself is verified separately by actually running
 * it (see server/CLAUDE.md § Verificación and this module's "Criterio de
 * hecho").
 */
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, testPool } from '../../db/testClient.js';
import { fetchRoomStayData } from '../repository.js';
import { calculateAvailability } from '../calculateAvailability.js';
import { createReservation, NoAvailabilityError } from '../createReservation.js';
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

interface ReservationFixtureOptions {
  roomId: number;
  roomUnitId: number;
  checkIn: string;
  checkOut: string;
  status?: string;
  expiresAt?: Date | null;
}

/**
 * Also writes matching `reservation_nights` rows (módulo 6A — one per night
 * in [checkIn, checkOut)) so the fixture reflects real occupancy under the
 * per-night model that repository.ts now reads from. This intentionally
 * writes rows regardless of `status` — tests that simulate stale data
 * (expired/cancelled reservations with leftover reservation_nights rows,
 * see reservationNights.test.ts) rely on that to set up the "stale rows
 * present" starting state the lazy sweep is meant to clean up.
 */
async function insertReservation(options: ReservationFixtureOptions): Promise<number> {
  const row = await testDb
    .insertInto('reservations')
    .values({
      room_id: options.roomId,
      room_unit_id: options.roomUnitId,
      check_in: options.checkIn,
      check_out: options.checkOut,
      guests: 2,
      status: options.status ?? 'confirmed',
      expires_at: options.expiresAt ?? null,
      total_cents: 10000,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const nights = eachNightUTC(options.checkIn, options.checkOut);
  if (nights.length > 0) {
    await testDb
      .insertInto('reservation_nights')
      .values(nights.map((night) => ({ reservation_id: row.id, night, room_unit_id: options.roomUnitId })))
      .execute();
  }

  return row.id;
}

beforeEach(async () => {
  await resetDb();
});

describe('room_units — seed shape', () => {
  it('produces 11 units total, exact labels, correct room type each', async () => {
    const casalId = await insertRoom('Casal', 2);
    const triploId = await insertRoom('Triplo', 3);
    const quadruploId = await insertRoom('Quádruplo', 4);

    await insertUnits(casalId, ['101', '102', '103', '104', '105', '106']);
    await insertUnits(triploId, ['7', '8', '9']);
    await insertUnits(quadruploId, ['10', '11']);

    const rows = await testDb
      .selectFrom('room_units')
      .innerJoin('rooms', 'rooms.id', 'room_units.room_id')
      .select(['room_units.label as label', 'rooms.name as room_name'])
      .execute();

    expect(rows).toHaveLength(11);

    const byRoom: Record<string, string[]> = { Casal: [], Triplo: [], Quádruplo: [] };
    for (const r of rows) byRoom[r.room_name].push(r.label);

    expect(byRoom.Casal.slice().sort()).toEqual(['101', '102', '103', '104', '105', '106']);
    expect(byRoom.Triplo.slice().sort()).toEqual(['7', '8', '9']);
    expect(byRoom['Quádruplo'].slice().sort()).toEqual(['10', '11']);
  });
});

describe('room_units — assignment', () => {
  it('assigns a unit of the same room type, the lowest-label one among the free units', async () => {
    const casalId = await insertRoom('Casal', 2);
    await insertUnits(casalId, ['103', '101', '102']);

    const result = await createReservation(testDb, {
      roomId: casalId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-03',
      guests: 2,
    });

    const row = await testDb
      .selectFrom('reservations')
      .innerJoin('room_units', 'room_units.id', 'reservations.room_unit_id')
      .select(['room_units.label as label', 'room_units.room_id as room_id'])
      .where('reservations.id', '=', result.id)
      .executeTakeFirstOrThrow();

    expect(row.room_id).toBe(casalId);
    expect(row.label).toBe('101');
  });

  it('two overlapping same-type reservations get distinct units', async () => {
    const casalId = await insertRoom('Casal', 2);
    await insertUnits(casalId, ['101', '102']);

    const first = await createReservation(testDb, {
      roomId: casalId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-03',
      guests: 2,
    });
    const second = await createReservation(testDb, {
      roomId: casalId,
      checkIn: '2026-09-02',
      checkOut: '2026-09-04',
      guests: 2,
    });

    const rows = await testDb
      .selectFrom('reservations')
      .select(['id', 'room_unit_id'])
      .where('id', 'in', [first.id, second.id])
      .execute();

    const unitIds = rows.map((r) => r.room_unit_id);
    expect(unitIds).toHaveLength(2);
    expect(new Set(unitIds).size).toBe(2);
  });

  it('rejects a stay when per-night aggregate counting alone would wrongly say available (no false fragmentation)', async () => {
    const casalId = await insertRoom('Casal', 2);
    const [unitA, unitB] = await insertUnits(casalId, ['101', '102']);

    // Unit A occupied on night 1 only, unit B occupied on night 3 only, of
    // a requested 2026-09-01 -> 2026-09-04 (3-night) stay. Per-night
    // aggregate counting would see 1 free unit every single night — but
    // NEITHER unit is actually free for the whole range.
    await insertReservation({ roomId: casalId, roomUnitId: unitA, checkIn: '2026-09-01', checkOut: '2026-09-02' });
    await insertReservation({ roomId: casalId, roomUnitId: unitB, checkIn: '2026-09-03', checkOut: '2026-09-04' });

    // Sanity check: prove the naive aggregate alone really would say
    // "available" here — this is the exact bug módulo 5 fixes.
    const stayData = await fetchRoomStayData(testDb, casalId, '2026-09-01', '2026-09-04');
    const naive = calculateAvailability({
      checkIn: '2026-09-01',
      checkOut: '2026-09-04',
      totalUnits: stayData!.totalUnits,
      overrides: stayData!.overrides,
      occupiedByDate: stayData!.occupiedByDate,
    });
    expect(naive.available).toBe(true);

    await expect(
      createReservation(testDb, { roomId: casalId, checkIn: '2026-09-01', checkOut: '2026-09-04', guests: 2 }),
    ).rejects.toBeInstanceOf(NoAvailabilityError);

    const count = await testDb
      .selectFrom('reservations')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('room_id', '=', casalId)
      .where('check_in', '=', new Date('2026-09-01'))
      .where('check_out', '=', new Date('2026-09-04'))
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(0);
  });
});

describe('room_units — exhaustion', () => {
  it('rejects with NO_AVAILABILITY when all 6 Casal units are occupied on some night in range, and creates no row', async () => {
    const casalId = await insertRoom('Casal', 2);
    const unitIds = await insertUnits(casalId, ['101', '102', '103', '104', '105', '106']);

    for (const unitId of unitIds) {
      await insertReservation({ roomId: casalId, roomUnitId: unitId, checkIn: '2026-09-01', checkOut: '2026-09-03' });
    }

    await expect(
      createReservation(testDb, { roomId: casalId, checkIn: '2026-09-01', checkOut: '2026-09-03', guests: 2 }),
    ).rejects.toBeInstanceOf(NoAvailabilityError);

    const count = await testDb
      .selectFrom('reservations')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('room_id', '=', casalId)
      .where('status', '!=', 'cancelled')
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(6);
  });
});

describe('room_units — release', () => {
  it('a cancelled reservation frees its unit for a new booking', async () => {
    const casalId = await insertRoom('Casal', 2);
    const [unitA] = await insertUnits(casalId, ['101']);
    await insertReservation({
      roomId: casalId,
      roomUnitId: unitA,
      checkIn: '2026-09-01',
      checkOut: '2026-09-03',
      status: 'cancelled',
    });

    const result = await createReservation(testDb, {
      roomId: casalId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-03',
      guests: 2,
    });

    const row = await testDb
      .selectFrom('reservations')
      .select('room_unit_id')
      .where('id', '=', result.id)
      .executeTakeFirstOrThrow();
    expect(row.room_unit_id).toBe(unitA);
  });

  it('an expired pending_payment reservation frees its unit for a new booking', async () => {
    const casalId = await insertRoom('Casal', 2);
    const [unitA] = await insertUnits(casalId, ['101']);
    await insertReservation({
      roomId: casalId,
      roomUnitId: unitA,
      checkIn: '2026-09-01',
      checkOut: '2026-09-03',
      status: 'pending_payment',
      expiresAt: new Date(Date.now() - 60_000),
    });

    const result = await createReservation(testDb, {
      roomId: casalId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-03',
      guests: 2,
    });

    const row = await testDb
      .selectFrom('reservations')
      .select('room_unit_id')
      .where('id', '=', result.id)
      .executeTakeFirstOrThrow();
    expect(row.room_unit_id).toBe(unitA);
  });
});

describe('room_units — calendar interaction', () => {
  it('units_available=2 caps assignability to 2 even though 6 physical units are free', async () => {
    const casalId = await insertRoom('Casal', 2);
    await insertUnits(casalId, ['101', '102', '103', '104', '105', '106']);
    await testDb
      .insertInto('rate_overrides')
      .values({ room_id: casalId, date: '2026-09-01', units_available: 2 })
      .execute();

    await createReservation(testDb, { roomId: casalId, checkIn: '2026-09-01', checkOut: '2026-09-02', guests: 2 });
    await createReservation(testDb, { roomId: casalId, checkIn: '2026-09-01', checkOut: '2026-09-02', guests: 2 });

    await expect(
      createReservation(testDb, { roomId: casalId, checkIn: '2026-09-01', checkOut: '2026-09-02', guests: 2 }),
    ).rejects.toBeInstanceOf(NoAvailabilityError);

    const count = await testDb
      .selectFrom('reservations')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('room_id', '=', casalId)
      .where('status', '!=', 'cancelled')
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(2);
  });

  it('closed=true still blocks everything even with physical units free', async () => {
    const casalId = await insertRoom('Casal', 2);
    await insertUnits(casalId, ['101', '102']);
    await testDb.insertInto('rate_overrides').values({ room_id: casalId, date: '2026-09-01', closed: true }).execute();

    await expect(
      createReservation(testDb, { roomId: casalId, checkIn: '2026-09-01', checkOut: '2026-09-02', guests: 2 }),
    ).rejects.toBeInstanceOf(NoAvailabilityError);
  });
});

describe('room_units — concurrency', () => {
  it('with 1 unit left, exactly one of two simultaneous creations wins, never double-booking the unit', async () => {
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

    // Same connection-pool proof pattern as módulo 2's own concurrency test.
    expect(testPool.totalCount).toBeGreaterThanOrEqual(2);

    const activeReservations = await testDb
      .selectFrom('reservations')
      .select(['id', 'room_unit_id'])
      .where('room_id', '=', casalId)
      .where('status', '!=', 'cancelled')
      .execute();

    expect(activeReservations).toHaveLength(1);
    expect(activeReservations[0].room_unit_id).toBe(unitA);
  });
});
