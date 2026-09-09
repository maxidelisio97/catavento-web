/**
 * SPEC-modulo-12C § 3.1: the core push function must (a) skip cleanly when
 * not connected/mapped, (b) build correct availability + restriction
 * payloads from real local data, and (c) NEVER throw — a Channex failure
 * must never surface to whatever local operation triggered the push. Mocks
 * `channexClient.js` (never hits the network); everything else runs against
 * the real test DB, same convention as channexRoomTypeMap.test.ts.
 */
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { setRoomTypeMap } from '../channexRoomTypeMap.js';
import { updateChannexConfig } from '../channexConfig.js';

const pushAvailabilityMock = vi.fn().mockResolvedValue(undefined);
const pushRestrictionsMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../channexClient.js', () => ({
  pushAvailability: (...args: unknown[]) => pushAvailabilityMock(...args),
  pushRestrictions: (...args: unknown[]) => pushRestrictionsMock(...args),
}));

const { pushAvailabilityForRange } = await import('../pushAvailability.js');

const PROPERTY_ID = 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f';
const ROOM_TYPE_ID = '7f1fe757-cf66-4878-82fe-ae25920e8d1f';
const RATE_PLAN_ID = '7e5f22ca-2c19-45a4-a96f-770312dc3d45';

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE reservation_nights, reservations, rate_overrides, room_rates, channex_room_type_map, channex_config, rooms RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

async function insertRoom(): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({ name: 'Casal', capacity: 2, adults_only: false, pets_allowed: false, default_min_stay: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();

  await testDb
    .insertInto('room_rates')
    .values({ room_id: room.id, occupancy: 2, weekday_cents: 20000, weekend_cents: 25000 })
    .execute();

  await testDb.insertInto('room_units').values({ room_id: room.id, label: '101' }).execute();
  await testDb.insertInto('room_units').values({ room_id: room.id, label: '102' }).execute();

  return room.id;
}

async function connectChannex(): Promise<void> {
  await updateChannexConfig(testDb, { propertyId: PROPERTY_ID, isActive: true });
}

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  vi.clearAllMocks();
  await resetDb();
});

describe('pushAvailabilityForRange', () => {
  it('does nothing when Channex is not configured/active', async () => {
    const roomId = await insertRoom();
    await setRoomTypeMap(testDb, { roomId, channexRoomTypeId: ROOM_TYPE_ID, channexRatePlanId: RATE_PLAN_ID });
    // No connectChannex() call — config stays inactive/unset.

    await pushAvailabilityForRange(testDb, { roomId, checkIn: '2026-07-16', checkOut: '2026-07-18' });

    expect(pushAvailabilityMock).not.toHaveBeenCalled();
    expect(pushRestrictionsMock).not.toHaveBeenCalled();
  });

  it('does nothing when the room has no Channex mapping (§ 3.1 step 3)', async () => {
    const roomId = await insertRoom();
    await connectChannex();
    // No setRoomTypeMap() call.

    await pushAvailabilityForRange(testDb, { roomId, checkIn: '2026-07-16', checkOut: '2026-07-18' });

    expect(pushAvailabilityMock).not.toHaveBeenCalled();
    expect(pushRestrictionsMock).not.toHaveBeenCalled();
  });

  it('pushes availability only, skipping restrictions, when the room type is mapped but the rate plan is not', async () => {
    const roomId = await insertRoom();
    await connectChannex();
    await setRoomTypeMap(testDb, { roomId, channexRoomTypeId: ROOM_TYPE_ID, channexRatePlanId: null });

    await pushAvailabilityForRange(testDb, { roomId, checkIn: '2026-07-16', checkOut: '2026-07-18' });

    expect(pushAvailabilityMock).toHaveBeenCalledTimes(1);
    expect(pushRestrictionsMock).not.toHaveBeenCalled();
  });

  it('pushes both availability (free-unit counts) and restrictions (per-occupancy rates) for a fully mapped room', async () => {
    const roomId = await insertRoom();
    await connectChannex();
    await setRoomTypeMap(testDb, { roomId, channexRoomTypeId: ROOM_TYPE_ID, channexRatePlanId: RATE_PLAN_ID });

    // 2026-07-16 is a Thursday (weekday), 2026-07-17 a Friday (weekend).
    await pushAvailabilityForRange(testDb, { roomId, checkIn: '2026-07-16', checkOut: '2026-07-18' });

    expect(pushAvailabilityMock).toHaveBeenCalledWith([
      { propertyId: PROPERTY_ID, roomTypeId: ROOM_TYPE_ID, date: '2026-07-16', availability: 2 },
      { propertyId: PROPERTY_ID, roomTypeId: ROOM_TYPE_ID, date: '2026-07-17', availability: 2 },
    ]);

    expect(pushRestrictionsMock).toHaveBeenCalledWith([
      {
        propertyId: PROPERTY_ID,
        ratePlanId: RATE_PLAN_ID,
        date: '2026-07-16',
        rates: [{ occupancy: 2, rate: 20000 }],
        minStay: 1,
        stopSell: false,
      },
      {
        propertyId: PROPERTY_ID,
        ratePlanId: RATE_PLAN_ID,
        date: '2026-07-17',
        rates: [{ occupancy: 2, rate: 25000 }],
        minStay: 1,
        stopSell: false,
      },
    ]);
  });

  it('reflects a confirmed reservation as reduced availability for its nights', async () => {
    const roomId = await insertRoom();
    await connectChannex();
    await setRoomTypeMap(testDb, { roomId, channexRoomTypeId: ROOM_TYPE_ID, channexRatePlanId: null });

    await testDb
      .insertInto('reservations')
      .values({
        room_id: roomId,
        check_in: '2026-07-16',
        check_out: '2026-07-17',
        guests: 2,
        status: 'confirmed',
        origin: 'web',
        total_cents: 20000,
      })
      .execute();

    await pushAvailabilityForRange(testDb, { roomId, checkIn: '2026-07-16', checkOut: '2026-07-18' });

    expect(pushAvailabilityMock).toHaveBeenCalledWith([
      { propertyId: PROPERTY_ID, roomTypeId: ROOM_TYPE_ID, date: '2026-07-16', availability: 1 },
      { propertyId: PROPERTY_ID, roomTypeId: ROOM_TYPE_ID, date: '2026-07-17', availability: 2 },
    ]);
  });

  it('never throws when the Channex client rejects — the caller must be able to await this safely', async () => {
    const roomId = await insertRoom();
    await connectChannex();
    await setRoomTypeMap(testDb, { roomId, channexRoomTypeId: ROOM_TYPE_ID, channexRatePlanId: null });
    pushAvailabilityMock.mockRejectedValueOnce(new Error('Channex is down'));

    await expect(
      pushAvailabilityForRange(testDb, { roomId, checkIn: '2026-07-16', checkOut: '2026-07-18' }),
    ).resolves.toBeUndefined();
  });
});
