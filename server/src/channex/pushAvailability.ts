/**
 * §3.1 — core outbound ARI push, reused by both the automatic per-operation
 * trigger (§ 3.2, `schedulePushAvailability`) and the manual full resync
 * (§ 3.3, `resyncAvailability.ts`).
 *
 * Fire-and-forget by design (§ 0.1): `schedulePushAvailability` is called
 * AFTER the local transaction that changed availability has already
 * committed, and deliberately never awaited by its callers — the
 * `try/catch` here must NEVER let an error escape, or a Channex outage would
 * start breaking local reservation/cancel/move operations, defeating the
 * entire point of this design. No retry beyond `channexClient.ts`'s own
 * 429 backoff — a lost push is corrected by the manual resync (this module)
 * or 12D's cron, not retried here (deuda consciente, SPEC § 0.1).
 */
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { fetchRoomStayData } from '../availability/repository.js';
import { calculateAvailability } from '../availability/calculateAvailability.js';
import { calculateNightlyRates } from '../pricing/calculateNightlyRates.js';
import { getChannexConfig } from './channexConfig.js';
import { findRoomTypeMapByRoomId } from './channexRoomTypeMap.js';
import { pushAvailability as pushAvailabilityToChannex, pushRestrictions, type ChannexAvailabilityValue, type ChannexRestrictionValue } from './channexClient.js';

export interface AvailabilityPushRange {
  roomId: number;
  /** 'YYYY-MM-DD'. */
  checkIn: string;
  /** 'YYYY-MM-DD', exclusive. */
  checkOut: string;
}

/**
 * Never dumps the full Channex request/response — same discipline as the
 * webhook/pull logging (SPEC-modulo-12B finding, reiterated in
 * SPEC-modulo-12C § 7) — just enough to locate which room/range failed.
 */
function logPushError(context: string, err: unknown): void {
  console.error(`[channex-push] ${context}:`, err instanceof Error ? err.message : err);
}

/**
 * Test-only bookkeeping (see `waitForPendingPushes` below) — a `Set` of every
 * fire-and-forget push currently in flight. Production callers never read
 * this; it exists solely so the test suite can drain stray async work
 * between test files. Registering here is unconditional and has zero effect
 * on production behavior — it's the promise itself (`pushRange(...)`, never
 * awaited by real callers) that stays fire-and-forget either way.
 */
const inFlight = new Set<Promise<void>>();

function track(promise: Promise<void>): void {
  inFlight.add(promise);
  void promise.finally(() => inFlight.delete(promise));
}

/**
 * Test-support only: awaits every push currently in flight. This module's
 * whole design is "never block the caller" (SPEC-modulo-12C § 0.1) — this
 * function is never called from production code, only from a global vitest
 * `afterEach` (test-support/flushChannexPushes.ts) that closes a real gap
 * found while investigating SPEC-modulo-12C's own test suite: dozens of
 * EXISTING test files exercise the 6 trigger points this module hooks into,
 * none of them aware a new unawaited DB read (`getChannexConfig`, at least)
 * now fires on every one of those calls. Under `fileParallelism: false`
 * (vitest.config.ts), that stray query can still be in flight when the NEXT
 * file's `beforeEach` TRUNCATEs the same tables — exactly the "abandoned
 * in-flight DB operation blocks a later test's TRUNCATE" failure class
 * server/CLAUDE.md already documents for a different root cause (vitest's
 * `testTimeout` not cancelling a real Postgres transaction). Confirmed by
 * A/B: `main` (pre-12C) ran the full suite 471/471 clean in one pass; this
 * branch's fire-and-forget pushes, unflushed, produced a hook-timeout flake
 * in an unrelated file (`panelTapeChart.test.ts`) that does not happen on
 * `main`. This drain closes that gap without changing production semantics
 * — the push is still never awaited by whatever local operation triggered it.
 */
export async function waitForPendingPushes(): Promise<void> {
  await Promise.allSettled(Array.from(inFlight));
}

async function pushRange(db: Kysely<DB>, range: AvailabilityPushRange): Promise<void> {
  try {
    const channexConfig = await getChannexConfig(db);
    if (!channexConfig.propertyId || !channexConfig.isActive) return;
    const propertyId = channexConfig.propertyId;

    const mapping = await findRoomTypeMapByRoomId(db, range.roomId);
    if (!mapping) return; // § 3.1 step 3: unmapped room type — nothing to push, not an error.

    const stayData = await fetchRoomStayData(db, range.roomId, range.checkIn, range.checkOut);
    if (!stayData) return; // room inactive/not found — nothing to push.

    const availability = calculateAvailability({
      checkIn: range.checkIn,
      checkOut: range.checkOut,
      totalUnits: stayData.totalUnits,
      overrides: stayData.overrides,
      occupiedByDate: stayData.occupiedByDate,
    });

    const availabilityValues: ChannexAvailabilityValue[] = availability.nights.map((night) => ({
      propertyId,
      roomTypeId: mapping.channexRoomTypeId,
      date: night.date,
      availability: night.disponibles,
    }));
    await pushAvailabilityToChannex(availabilityValues);

    // § 1.2: rates/restrictions only go out when a rate plan is mapped too —
    // a room can have its room type mapped (availability pushable) before
    // its rate plan is (getMappingStatus's "complete" requires both).
    if (mapping.channexRatePlanId) {
      const ratePlanId = mapping.channexRatePlanId;
      const nightlyRates = calculateNightlyRates({
        checkIn: range.checkIn,
        checkOut: range.checkOut,
        roomRates: stayData.roomRates,
        rateOverrides: stayData.overrides,
        roomDefaultMinStay: stayData.defaultMinStay,
      });

      const restrictionValues: ChannexRestrictionValue[] = nightlyRates.map((night) => ({
        propertyId,
        ratePlanId,
        date: night.date,
        rates: night.ratesByOccupancy.map((r) => ({ occupancy: r.occupancy, rate: r.priceCents })),
        minStay: night.minStay,
        stopSell: night.closed,
      }));
      await pushRestrictions(restrictionValues);
    }
  } catch (err) {
    logPushError(`room ${range.roomId} [${range.checkIn}..${range.checkOut})`, err);
  }
}

/**
 * § 3.2: entry point for every automatic trigger. Accepts multiple ranges
 * (deduped) because some operations affect two distinct room types in one
 * go — a cross-room-type `moveReservation` (origin + destination), or an
 * OTA modification that changes dates/room (old range freed + new range
 * occupied, SPEC-modulo-12C § 8) — and a `null`/`undefined` entry is a
 * convenience for call sites that only conditionally have a second range.
 * Never awaited by its callers: each range is pushed independently and
 * asynchronously, so one failing push never blocks or delays another.
 */
export function schedulePushAvailability(db: Kysely<DB>, ranges: (AvailabilityPushRange | null | undefined)[]): void {
  const seen = new Set<string>();
  for (const range of ranges) {
    if (!range) continue;
    const key = `${range.roomId}|${range.checkIn}|${range.checkOut}`;
    if (seen.has(key)) continue;
    seen.add(key);
    track(pushRange(db, range));
  }
}

/** Exposed for resyncAvailability.ts, which awaits each push directly (no fire-and-forget there — see that file). */
export { pushRange as pushAvailabilityForRange };

async function reservationRange(db: Kysely<DB>, reservationId: number): Promise<AvailabilityPushRange | null> {
  const row = await db
    .selectFrom('reservations')
    .select(['room_id', sql<string>`check_in::text`.as('check_in'), sql<string>`check_out::text`.as('check_out')])
    .where('id', '=', reservationId)
    .executeTakeFirst();

  if (!row) return null;
  return { roomId: row.room_id, checkIn: row.check_in, checkOut: row.check_out };
}

/**
 * Convenience for trigger call sites that only have a `reservationId` in
 * hand (confirmPendingReservation, cancelReservation, retryOtaConflict, and
 * processBookingRevision's new-booking/cancellation paths — none of these
 * change a reservation's room/dates, so its CURRENT row already has the
 * right range to push). Re-reads outside any transaction, after the
 * caller's own commit — a plain read, not `forUpdate`, since this is a
 * best-effort snapshot for an outbound sync, not a write that needs
 * serialization. Entirely fire-and-forget like `schedulePushAvailability`:
 * the read itself is never awaited by the caller either.
 */
export function schedulePushAvailabilityForReservation(db: Kysely<DB>, reservationIds: (number | null | undefined)[]): void {
  for (const reservationId of reservationIds) {
    if (reservationId === null || reservationId === undefined) continue;
    track(
      (async () => {
        try {
          const range = await reservationRange(db, reservationId);
          if (range) await pushRange(db, range);
        } catch (err) {
          logPushError(`reservation ${reservationId}`, err);
        }
      })(),
    );
  }
}
