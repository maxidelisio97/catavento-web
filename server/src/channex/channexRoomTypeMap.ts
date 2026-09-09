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

/**
 * Reverse lookup for SPEC-modulo-12B-reservas-entrantes.md § 3.1 step 1: a
 * Booking Revision from Channex carries `channex_room_type_id`, and we need
 * our local `room_id` to call `createReservation`. Returns `null` (not a
 * thrown error) when there's no mapping — the caller decides how to treat
 * an unmapped room type (§ 3.1: "tratar como error a loggear", not a crash).
 */
export async function findRoomIdByChannexRoomTypeId(
  db: Kysely<DB>,
  channexRoomTypeId: string,
): Promise<number | null> {
  const row = await db
    .selectFrom('channex_room_type_map')
    .select('room_id')
    .where('channex_room_type_id', '=', channexRoomTypeId)
    .executeTakeFirst();

  return row?.room_id ?? null;
}

/**
 * Forward lookup for SPEC-modulo-12C § 3.1 step 3: the push function knows
 * the LOCAL `room_id` (from the reservation/availability it's pushing for)
 * and needs the Channex ids to address the ARI endpoints. Returns `null`
 * (not a thrown error) when there's no mapping — same contract as
 * `findRoomIdByChannexRoomTypeId`, the caller decides how to treat an
 * unmapped room (§ 3.1: log and skip, don't push).
 */
export async function findRoomTypeMapByRoomId(
  db: Kysely<DB>,
  roomId: number,
): Promise<{ channexRoomTypeId: string; channexRatePlanId: string | null } | null> {
  const row = await db
    .selectFrom('channex_room_type_map')
    .select(['channex_room_type_id', 'channex_rate_plan_id'])
    .where('room_id', '=', roomId)
    .executeTakeFirst();

  if (!row) return null;
  return { channexRoomTypeId: row.channex_room_type_id, channexRatePlanId: row.channex_rate_plan_id };
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
