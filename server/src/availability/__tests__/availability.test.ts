import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { fetchRoomStayData } from '../repository.js';
import { calculateAvailability } from '../calculateAvailability.js';
import { createReservation, MinStayNotMetError, NoAvailabilityError } from '../createReservation.js';

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE reservations, rate_overrides, room_rates, rooms RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

interface RoomFixtureOptions {
  totalUnits?: number;
  defaultMinStay?: number;
  capacity?: number;
}

async function insertTestRoom(options: RoomFixtureOptions = {}): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({
      name: 'TestRoom',
      capacity: options.capacity ?? 2,
      pets_allowed: false,
      default_min_stay: options.defaultMinStay ?? 1,
      total_units: options.totalUnits ?? 3,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await testDb
    .insertInto('room_rates')
    .values({
      room_id: room.id,
      occupancy: 2,
      weekday_cents: 10000,
      weekend_cents: 15000,
    })
    .execute();

  return room.id;
}

async function getAvailability(roomId: number, checkIn: string, checkOut: string) {
  const stayData = await fetchRoomStayData(testDb, roomId, checkIn, checkOut);
  if (!stayData) throw new Error('Room not found in test fixture');
  return calculateAvailability({
    checkIn,
    checkOut,
    totalUnits: stayData.totalUnits,
    overrides: stayData.overrides,
    occupiedByDate: stayData.occupiedByDate,
  });
}

beforeEach(async () => {
  await resetDb();
});

describe('availability — no reservations', () => {
  it('disponibles equals total_units on every night', async () => {
    const roomId = await insertTestRoom({ totalUnits: 3 });

    const result = await getAvailability(roomId, '2026-08-10', '2026-08-13');

    expect(result.nights).toHaveLength(3);
    expect(result.nights.every((n) => n.disponibles === 3)).toBe(true);
    expect(result.available).toBe(true);
    expect(result.unitsLeft).toBe(3);
  });
});

describe('availability — occupied nights from a confirmed reservation', () => {
  it('a 10->13 stay occupies nights 10, 11, 12 but not the checkout night 13', async () => {
    const roomId = await insertTestRoom({ totalUnits: 1 });

    await testDb
      .insertInto('reservations')
      .values({
        room_id: roomId,
        check_in: '2026-08-10',
        check_out: '2026-08-13',
        guests: 2,
        status: 'confirmed',
        total_cents: 30000,
      })
      .execute();

    const result = await getAvailability(roomId, '2026-08-10', '2026-08-14');
    const byDate = Object.fromEntries(result.nights.map((n) => [n.date, n]));

    expect(byDate['2026-08-10'].ocupadas).toBe(1);
    expect(byDate['2026-08-11'].ocupadas).toBe(1);
    expect(byDate['2026-08-12'].ocupadas).toBe(1);
    expect(byDate['2026-08-13'].ocupadas).toBe(0);
  });
});

describe('availability — rate_overrides', () => {
  it('units_available on an override reduces cupo for that night', async () => {
    const roomId = await insertTestRoom({ totalUnits: 3 });

    await testDb
      .insertInto('rate_overrides')
      .values({ room_id: roomId, date: '2026-08-11', units_available: 1 })
      .execute();

    const result = await getAvailability(roomId, '2026-08-10', '2026-08-13');
    const byDate = Object.fromEntries(result.nights.map((n) => [n.date, n]));

    expect(byDate['2026-08-10'].cupo).toBe(3);
    expect(byDate['2026-08-11'].cupo).toBe(1);
    expect(byDate['2026-08-12'].cupo).toBe(3);
  });

  it('closed=true gives cupo 0 even when units_available says otherwise', async () => {
    const roomId = await insertTestRoom({ totalUnits: 3 });

    await testDb
      .insertInto('rate_overrides')
      .values({ room_id: roomId, date: '2026-08-11', units_available: 5, closed: true })
      .execute();

    const result = await getAvailability(roomId, '2026-08-10', '2026-08-13');
    const byDate = Object.fromEntries(result.nights.map((n) => [n.date, n]));

    expect(byDate['2026-08-11'].cupo).toBe(0);
  });
});

describe('availability — reservation status', () => {
  it('cancelled never occupies; expired pending_payment never occupies; live pending_payment occupies', async () => {
    const roomId = await insertTestRoom({ totalUnits: 3 });
    const night = '2026-08-11';
    const pastExpiry = new Date(Date.now() - 60_000);
    const futureExpiry = new Date(Date.now() + 60_000);

    await testDb
      .insertInto('reservations')
      .values([
        {
          room_id: roomId,
          check_in: night,
          check_out: '2026-08-12',
          guests: 2,
          status: 'cancelled',
          total_cents: 10000,
        },
        {
          room_id: roomId,
          check_in: night,
          check_out: '2026-08-12',
          guests: 2,
          status: 'pending_payment',
          expires_at: pastExpiry,
          total_cents: 10000,
        },
        {
          room_id: roomId,
          check_in: night,
          check_out: '2026-08-12',
          guests: 2,
          status: 'pending_payment',
          expires_at: futureExpiry,
          total_cents: 10000,
        },
      ])
      .execute();

    const result = await getAvailability(roomId, '2026-08-10', '2026-08-13');
    const byDate = Object.fromEntries(result.nights.map((n) => [n.date, n]));

    expect(byDate[night].ocupadas).toBe(1);
  });
});

describe('createReservation — anti-overbooking', () => {
  it('rejects with NO_AVAILABILITY when one night in the range is full, and leaves no row behind', async () => {
    const roomId = await insertTestRoom({ totalUnits: 1 });

    await testDb
      .insertInto('reservations')
      .values({
        room_id: roomId,
        check_in: '2026-08-11',
        check_out: '2026-08-12',
        guests: 2,
        status: 'confirmed',
        total_cents: 10000,
      })
      .execute();

    await expect(
      createReservation(testDb, {
        roomId,
        checkIn: '2026-08-10',
        checkOut: '2026-08-13',
        guests: 2,
      }),
    ).rejects.toBeInstanceOf(NoAvailabilityError);

    const count = await testDb
      .selectFrom('reservations')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('check_in', '=', new Date('2026-08-10'))
      .executeTakeFirstOrThrow();

    expect(Number(count.count)).toBe(0);
  });

  it('rejects a stay shorter than the applicable min_stay', async () => {
    const roomId = await insertTestRoom({ totalUnits: 3, defaultMinStay: 2 });

    await expect(
      createReservation(testDb, {
        roomId,
        checkIn: '2026-08-10',
        checkOut: '2026-08-11',
        guests: 2,
      }),
    ).rejects.toBeInstanceOf(MinStayNotMetError);
  });
});

describe('createReservation — concurrency', () => {
  it('with 1 unit left, exactly one of two simultaneous requests wins', async () => {
    const roomId = await insertTestRoom({ totalUnits: 1 });

    const attempt = () =>
      createReservation(testDb, {
        roomId,
        checkIn: '2026-09-01',
        checkOut: '2026-09-03',
        guests: 2,
      });

    const results = await Promise.allSettled([attempt(), attempt()]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(NoAvailabilityError);

    const activeCount = await testDb
      .selectFrom('reservations')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('room_id', '=', roomId)
      .where('status', '!=', 'cancelled')
      .executeTakeFirstOrThrow();

    expect(Number(activeCount.count)).toBe(1);
  });
});
