/**
 * §3.3 — manual full resync: recalculates and pushes ARI for every mapped
 * room type across the whole sync horizon (§ 4, 6 months). Independent of
 * the incremental push (§ 3.2) — corrects drift accumulated from a lost
 * push, doesn't replace it. No cron here (12D adds the schedule).
 *
 * Reuses the exact same per-range push (`pushAvailabilityForRange`,
 * pushAvailability.ts's § 3.1 core) the automatic triggers use — one room
 * over the full 6-month range still fits in ONE `POST /availability` +
 * ONE `POST /restrictions` call each (Channex's `values` array carries every
 * night), so no extra batching is needed here: with 3 room types that's 6
 * requests total, nowhere near the rate limiter's 10/min (SPEC § 3.4). This
 * endpoint simply awaits the whole sequence and lets the request take as
 * long as it takes (documented choice, SPEC § 3.3 — "a criterio de
 * implementación") rather than returning a background "en curso" status:
 * the pousada's real volume makes this a few seconds, not worth the extra
 * polling machinery.
 */
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { addDaysUTC, formatDateUTC, parseDateUTC, todayISO } from '../shared/dateUtils.js';
import { listLocalRoomsWithMapping } from './channexRoomTypeMap.js';
import { pushAvailabilityForRange } from './pushAvailability.js';

/** SPEC-modulo-12C § 4: 6 meses a futuro. */
export const RESYNC_HORIZON_DAYS = 183;

export interface ResyncAvailabilityResult {
  roomsPushed: number;
  /** Active local rooms with no Channex room type mapped yet — nothing to push for them, same as § 3.1 step 3. */
  roomsSkipped: number;
}

export async function resyncAvailability(db: Kysely<DB>): Promise<ResyncAvailabilityResult> {
  const rooms = await listLocalRoomsWithMapping(db);

  const checkIn = todayISO();
  const checkOut = formatDateUTC(addDaysUTC(parseDateUTC(checkIn), RESYNC_HORIZON_DAYS));

  let roomsPushed = 0;
  let roomsSkipped = 0;

  for (const room of rooms) {
    if (!room.channexRoomTypeId) {
      roomsSkipped++;
      continue;
    }
    // pushAvailabilityForRange never throws (SPEC § 3.1: logs and swallows
    // its own errors) — a single room failing here doesn't abort the rest
    // of the resync, same fire-and-forget discipline as the automatic
    // triggers, just awaited in sequence instead of scheduled in the
    // background.
    await pushAvailabilityForRange(db, { roomId: room.roomId, checkIn, checkOut });
    roomsPushed++;
  }

  return { roomsPushed, roomsSkipped };
}
