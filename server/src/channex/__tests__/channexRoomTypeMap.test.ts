import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { getMappingStatus, listLocalRoomsWithMapping, setRoomTypeMap } from '../channexRoomTypeMap.js';
import { isChannexRoomTypeUniqueViolation } from '../isChannexRoomTypeUniqueViolation.js';

async function insertRoom(name: string, active = true): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({ name, capacity: 2, adults_only: false, pets_allowed: false, default_min_stay: 1, active })
    .returning('id')
    .executeTakeFirstOrThrow();
  return room.id;
}

beforeEach(async () => {
  // TRUNCATE ... CASCADE (server/CLAUDE.md's test-cleanup convention) — a
  // plain DELETE on `rooms` would block on any FK another module's tests
  // leave pointing at it between files.
  await sql`TRUNCATE TABLE rooms RESTART IDENTITY CASCADE`.execute(testDb);
});

afterEach(async () => {
  await sql`TRUNCATE TABLE rooms RESTART IDENTITY CASCADE`.execute(testDb);
});

describe('listLocalRoomsWithMapping', () => {
  it('returns active rooms with a null mapping when none exists yet', async () => {
    await insertRoom('Casal');

    const rooms = await listLocalRoomsWithMapping(testDb);

    expect(rooms).toEqual([
      { roomId: expect.any(Number), roomName: 'Casal', channexRoomTypeId: null, channexRatePlanId: null },
    ]);
  });

  it('excludes inactive rooms', async () => {
    await insertRoom('Casal');
    await insertRoom('Descontinuado', false);

    const rooms = await listLocalRoomsWithMapping(testDb);

    expect(rooms.map((r) => r.roomName)).toEqual(['Casal']);
  });

  it('includes the mapping once one is set', async () => {
    const roomId = await insertRoom('Casal');
    await setRoomTypeMap(testDb, {
      roomId,
      channexRoomTypeId: '7f1fe757-cf66-4878-82fe-ae25920e8d1f',
      channexRatePlanId: '7e5f22ca-2c19-45a4-a96f-770312dc3d45',
    });

    const rooms = await listLocalRoomsWithMapping(testDb);

    expect(rooms).toEqual([
      {
        roomId,
        roomName: 'Casal',
        channexRoomTypeId: '7f1fe757-cf66-4878-82fe-ae25920e8d1f',
        channexRatePlanId: '7e5f22ca-2c19-45a4-a96f-770312dc3d45',
      },
    ]);
  });
});

describe('setRoomTypeMap', () => {
  it('upserts: a second call for the same room replaces its mapping instead of duplicating it', async () => {
    const roomId = await insertRoom('Casal');
    await setRoomTypeMap(testDb, { roomId, channexRoomTypeId: '7f1fe757-cf66-4878-82fe-ae25920e8d1f', channexRatePlanId: null });
    await setRoomTypeMap(testDb, {
      roomId,
      channexRoomTypeId: '7f1fe757-cf66-4878-82fe-ae25920e8d1f',
      channexRatePlanId: '7e5f22ca-2c19-45a4-a96f-770312dc3d45',
    });

    const rows = await testDb.selectFrom('channex_room_type_map').selectAll().where('room_id', '=', roomId).execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].channex_rate_plan_id).toBe('7e5f22ca-2c19-45a4-a96f-770312dc3d45');
  });

  it('rejects a second local room claiming a Channex room type another room already owns (1:1 mapping)', async () => {
    const roomA = await insertRoom('Casal');
    const roomB = await insertRoom('Triplo');
    await setRoomTypeMap(testDb, { roomId: roomA, channexRoomTypeId: '7f1fe757-cf66-4878-82fe-ae25920e8d1f', channexRatePlanId: null });

    const error = await setRoomTypeMap(testDb, {
      roomId: roomB,
      channexRoomTypeId: '7f1fe757-cf66-4878-82fe-ae25920e8d1f',
      channexRatePlanId: null,
    }).catch((e) => e);

    expect(isChannexRoomTypeUniqueViolation(error)).toBe(true);
  });
});

describe('getMappingStatus', () => {
  it('is incomplete with zero rooms mapped', async () => {
    await insertRoom('Casal');

    const status = await getMappingStatus(testDb);

    expect(status).toEqual({ complete: false, totalRooms: 1, mappedRooms: 0 });
  });

  it('is incomplete when a room has a room type but no rate plan yet', async () => {
    const roomId = await insertRoom('Casal');
    await setRoomTypeMap(testDb, { roomId, channexRoomTypeId: '7f1fe757-cf66-4878-82fe-ae25920e8d1f', channexRatePlanId: null });

    const status = await getMappingStatus(testDb);

    expect(status).toEqual({ complete: false, totalRooms: 1, mappedRooms: 0 });
  });

  it('is complete once every active room has both a room type and a rate plan mapped', async () => {
    const roomId = await insertRoom('Casal');
    await setRoomTypeMap(testDb, {
      roomId,
      channexRoomTypeId: '7f1fe757-cf66-4878-82fe-ae25920e8d1f',
      channexRatePlanId: '7e5f22ca-2c19-45a4-a96f-770312dc3d45',
    });

    const status = await getMappingStatus(testDb);

    expect(status).toEqual({ complete: true, totalRooms: 1, mappedRooms: 1 });
  });

  it('stays incomplete if only some active rooms are mapped', async () => {
    const roomA = await insertRoom('Casal');
    await insertRoom('Triplo');
    await setRoomTypeMap(testDb, {
      roomId: roomA,
      channexRoomTypeId: '7f1fe757-cf66-4878-82fe-ae25920e8d1f',
      channexRatePlanId: '7e5f22ca-2c19-45a4-a96f-770312dc3d45',
    });

    const status = await getMappingStatus(testDb);

    expect(status).toEqual({ complete: false, totalRooms: 2, mappedRooms: 1 });
  });
});
