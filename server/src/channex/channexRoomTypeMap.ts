import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';

export interface LocalRoomMapping {
  roomId: number;
  roomName: string;
  channexRoomTypeId: string | null;
  channexRatePlanId: string | null;
}

/** All active local room types, each with its current Channex mapping (if any) — for GET /panel/channex/room-types. */
export async function listLocalRoomsWithMapping(db: Kysely<DB>): Promise<LocalRoomMapping[]> {
  const rows = await db
    .selectFrom('rooms')
    .leftJoin('channex_room_type_map', 'channex_room_type_map.room_id', 'rooms.id')
    .select([
      'rooms.id as roomId',
      'rooms.name as roomName',
      'channex_room_type_map.channex_room_type_id as channexRoomTypeId',
      'channex_room_type_map.channex_rate_plan_id as channexRatePlanId',
    ])
    .where('rooms.active', '=', true)
    .orderBy('rooms.sort_order')
    .execute();

  return rows;
}

export interface SetRoomTypeMapInput {
  roomId: number;
  channexRoomTypeId: string;
  channexRatePlanId: string | null;
}

/**
 * Upserts the mapping for one local room. `room_id` is UNIQUE (§ 3) so this
 * is the single row per room — a second call for the same room replaces its
 * mapping rather than adding a duplicate. The `channex_room_type_id` UNIQUE
 * constraint is left to the database: a caller trying to claim a Channex
 * room type another local room already owns gets a Postgres unique
 * violation, which the plugin translates to a 409 (SPEC § 8: mapping must be
 * 1:1, no orphans).
 */
export async function setRoomTypeMap(db: Kysely<DB>, input: SetRoomTypeMapInput): Promise<void> {
  await db
    .insertInto('channex_room_type_map')
    .values({
      room_id: input.roomId,
      channex_room_type_id: input.channexRoomTypeId,
      channex_rate_plan_id: input.channexRatePlanId,
    })
    .onConflict((oc) =>
      oc.column('room_id').doUpdateSet({
        channex_room_type_id: input.channexRoomTypeId,
        channex_rate_plan_id: input.channexRatePlanId,
      }),
    )
    .execute();
}

export interface MappingStatus {
  complete: boolean;
  totalRooms: number;
  mappedRooms: number;
}

/** "Mapeo completo" (§ 6) = every active local room has a Channex room type AND rate plan mapped. */
export async function getMappingStatus(db: Kysely<DB>): Promise<MappingStatus> {
  const rooms = await listLocalRoomsWithMapping(db);
  const mappedRooms = rooms.filter((room) => room.channexRoomTypeId !== null && room.channexRatePlanId !== null).length;

  return { complete: rooms.length > 0 && mappedRooms === rooms.length, totalRooms: rooms.length, mappedRooms };
}
