/**
 * Direct proof for the fix in fix-resync-fullsync-2-calls: Channex's
 * certification guide requires a full sync to be EXACTLY 2 API calls total
 * (1 x availability for ALL room types, 1 x restrictions for ALL rate
 * plans) — never one call per room type. Mocks `channexClient.js` (never
 * hits the network) and counts calls directly, so this fails loudly if the
 * resync ever regresses back to a per-room-type push.
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

const { resyncAvailability, RESYNC_HORIZON_DAYS } = await import('../resyncAvailability.js');

const PROPERTY_ID = 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f';

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE reservation_nights, reservations, rate_overrides, room_rates, channex_room_type_map, channex_config, rooms RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

async function insertMappedRoom(name: string, channexRoomTypeId: string, channexRatePlanId: string): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({ name, capacity: 2, adults_only: false, pets_allowed: false, default_min_stay: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();

  await testDb.insertInto('room_rates').values({ room_id: room.id, occupancy: 2, weekday_cents: 20000, weekend_cents: 25000 }).execute();
  await testDb.insertInto('room_units').values({ room_id: room.id, label: `${name}-101` }).execute();
  await setRoomTypeMap(testDb, { roomId: room.id, channexRoomTypeId, channexRatePlanId });

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

describe('resyncAvailability', () => {
  it('pushes exactly 1 availability call and 1 restrictions call for 3 mapped room types, never one per room type', async () => {
    await connectChannex();
    const ROOM_TYPE_CASAL = '7f1fe757-cf66-4878-82fe-ae25920e8d1f';
    const ROOM_TYPE_TRIPLO = '11111111-1111-4111-8111-111111111111';
    const ROOM_TYPE_QUADRUPLO = '22222222-2222-4222-8222-222222222222';
    const RATE_PLAN_CASAL = '7e5f22ca-2c19-45a4-a96f-770312dc3d45';
    const RATE_PLAN_TRIPLO = '33333333-3333-4333-8333-333333333333';
    const RATE_PLAN_QUADRUPLO = '44444444-4444-4444-8444-444444444444';

    await insertMappedRoom('Casal', ROOM_TYPE_CASAL, RATE_PLAN_CASAL);
    await insertMappedRoom('Triplo', ROOM_TYPE_TRIPLO, RATE_PLAN_TRIPLO);
    await insertMappedRoom('Quadruplo', ROOM_TYPE_QUADRUPLO, RATE_PLAN_QUADRUPLO);

    const result = await resyncAvailability(testDb);

    expect(result).toEqual({ roomsPushed: 3, roomsSkipped: 0 });
    expect(pushAvailabilityMock).toHaveBeenCalledTimes(1);
    expect(pushRestrictionsMock).toHaveBeenCalledTimes(1);

    // One call, but carrying every room type's nights — not a fraction of them.
    const [availabilityValues] = pushAvailabilityMock.mock.calls[0] as [{ roomTypeId: string }[]];
    const [restrictionValues] = pushRestrictionsMock.mock.calls[0] as [{ ratePlanId: string }[]];
    expect(availabilityValues).toHaveLength(3 * RESYNC_HORIZON_DAYS);
    expect(restrictionValues).toHaveLength(3 * RESYNC_HORIZON_DAYS);
    expect(new Set(availabilityValues.map((v) => v.roomTypeId))).toEqual(
      new Set([ROOM_TYPE_CASAL, ROOM_TYPE_TRIPLO, ROOM_TYPE_QUADRUPLO]),
    );
    expect(new Set(restrictionValues.map((v) => v.ratePlanId))).toEqual(
      new Set([RATE_PLAN_CASAL, RATE_PLAN_TRIPLO, RATE_PLAN_QUADRUPLO]),
    );
  });

  it('skips rooms with no Channex room type mapped, without calling either push', async () => {
    await connectChannex();
    const room = await testDb
      .insertInto('rooms')
      .values({ name: 'Casal', capacity: 2, adults_only: false, pets_allowed: false, default_min_stay: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await testDb.insertInto('room_units').values({ room_id: room.id, label: 'Casal-101' }).execute();
    // No setRoomTypeMap() call — left unmapped on purpose.

    const result = await resyncAvailability(testDb);

    expect(result).toEqual({ roomsPushed: 0, roomsSkipped: 1 });
    expect(pushAvailabilityMock).not.toHaveBeenCalled();
    expect(pushRestrictionsMock).not.toHaveBeenCalled();
  });

  it('does nothing when Channex is not configured/active', async () => {
    await insertMappedRoom('Casal', '7f1fe757-cf66-4878-82fe-ae25920e8d1f', '7e5f22ca-2c19-45a4-a96f-770312dc3d45');
    // No connectChannex() call — config stays inactive/unset.

    const result = await resyncAvailability(testDb);

    expect(result).toEqual({ roomsPushed: 0, roomsSkipped: 1 });
    expect(pushAvailabilityMock).not.toHaveBeenCalled();
    expect(pushRestrictionsMock).not.toHaveBeenCalled();
  });

  it('pushes availability only, skipping restrictions, when a room type is mapped but its rate plan is not', async () => {
    await connectChannex();
    const room = await testDb
      .insertInto('rooms')
      .values({ name: 'Casal', capacity: 2, adults_only: false, pets_allowed: false, default_min_stay: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await testDb.insertInto('room_units').values({ room_id: room.id, label: 'Casal-101' }).execute();
    await setRoomTypeMap(testDb, { roomId: room.id, channexRoomTypeId: '7f1fe757-cf66-4878-82fe-ae25920e8d1f', channexRatePlanId: null });

    const result = await resyncAvailability(testDb);

    expect(result).toEqual({ roomsPushed: 1, roomsSkipped: 0 });
    expect(pushAvailabilityMock).toHaveBeenCalledTimes(1);
    expect(pushRestrictionsMock).not.toHaveBeenCalled();
  });
});
