/**
 * §3.3 — manual full resync: recalculates and pushes ARI for every mapped
 * room type across the whole sync horizon. Independent of the incremental
 * push (§ 3.2) — corrects drift accumulated from a lost push, doesn't
 * replace it. No cron here (12D adds the schedule for the reservation pull
 * only — Channex certification explicitly rejects a full sync fired on a
 * timer, "Test case #1. Full Sync").
 *
 * Channex's certification guide (docs.channex.io) requires a full sync to be
 * EXACTLY 2 API calls total, each covering 500 days: one `POST /availability`
 * covering every mapped room type, one `POST /restrictions` covering every
 * mapped rate plan — a per-room-type call, or a horizon short of 500 days, is
 * flagged as a certification failure. This builds each room's `values` via
 * `buildRangeAriValues` (pushAvailability.ts's § 3.1 core, shared with the
 * per-event trigger path) WITHOUT pushing per room, accumulates every room's
 * values into two flat arrays, and pushes each array exactly once after the
 * loop — regardless of how many room types are mapped. This endpoint simply
 * awaits the whole sequence and lets the request take as long as it takes
 * (documented choice, SPEC § 3.3 — "a criterio de implementación") rather
 * than returning a background "en curso" status: the pousada's real volume
 * makes this a few seconds, not worth the extra polling machinery.
 */
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { addDaysUTC, formatDateUTC, parseDateUTC, todayISO } from '../shared/dateUtils.js';
import { listLocalRoomsWithMapping } from './channexRoomTypeMap.js';
import { getChannexConfig } from './channexConfig.js';
import { buildRangeAriValues } from './pushAvailability.js';
import {
  pushAvailability as pushAvailabilityToChannex,
  pushRestrictions,
  type ChannexAvailabilityValue,
  type ChannexRestrictionValue,
} from './channexClient.js';

/**
 * Channex certification's "Test case #1. Full Sync" requires exactly 500
 * days. This is the number declared to Channex as what the PMS supports —
 * independent of `panelRoomRates.ts`'s own horizon for the 7th incremental
 * trigger (a business tradeoff, not a certified capability), which has its
 * own constant so a future change to either doesn't silently move the other.
 */
export const FULL_SYNC_HORIZON_DAYS = 500;

export interface ResyncAvailabilityResult {
  roomsPushed: number;
  /** Active local rooms with no Channex room type mapped yet — nothing to push for them, same as § 3.1 step 3. */
  roomsSkipped: number;
}

export async function resyncAvailability(db: Kysely<DB>): Promise<ResyncAvailabilityResult> {
  const channexConfig = await getChannexConfig(db);
  const rooms = await listLocalRoomsWithMapping(db);

  if (!channexConfig.propertyId || !channexConfig.isActive) {
    return { roomsPushed: 0, roomsSkipped: rooms.length };
  }
  const propertyId = channexConfig.propertyId;

  const checkIn = todayISO();
  const checkOut = formatDateUTC(addDaysUTC(parseDateUTC(checkIn), FULL_SYNC_HORIZON_DAYS));

  let roomsPushed = 0;
  let roomsSkipped = 0;
  const allAvailabilityValues: ChannexAvailabilityValue[] = [];
  const allRestrictionValues: ChannexRestrictionValue[] = [];

  for (const room of rooms) {
    if (!room.channexRoomTypeId) {
      roomsSkipped++;
      continue;
    }

    // Unlike pushRange (§ 3.2's per-event push), this is NOT wrapped in a
    // try/catch: buildRangeAriValues does real DB reads (room type mapping,
    // stay data) that CAN throw on a genuine DB error, and a throw here
    // aborts the whole resync without pushing anything — even the rooms
    // already accumulated before it. Deliberate: this endpoint is a manual,
    // awaited, on-demand action (SPEC § 3.3), so a hard failure surfacing to
    // the staff member who clicked "resync" (they can just retry) is
    // preferable to silently swallowing a DB error per room and reporting a
    // false "roomsPushed: N" success, which is what the old per-room
    // try/catch actually did.
    const ariValues = await buildRangeAriValues(db, propertyId, { roomId: room.roomId, checkIn, checkOut });
    if (!ariValues) {
      roomsSkipped++;
      continue;
    }

    allAvailabilityValues.push(...ariValues.availabilityValues);
    allRestrictionValues.push(...ariValues.restrictionValues);
    roomsPushed++;
  }

  // Exactly 2 calls total, never one per room type — Channex's
  // certification guide requires a full sync to be 1 call for availability
  // (all room types) + 1 call for rates/restrictions (all rate plans). Each
  // call is skipped (not fired with an empty `values`) when nothing was
  // mapped/mapped-with-a-rate-plan, same "don't push nothing" contract the
  // per-event trigger path already has.
  if (allAvailabilityValues.length > 0) {
    await pushAvailabilityToChannex(allAvailabilityValues);
  }
  if (allRestrictionValues.length > 0) {
    await pushRestrictions(allRestrictionValues);
  }

  return { roomsPushed, roomsSkipped };
}
