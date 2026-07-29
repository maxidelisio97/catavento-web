/**
 * rate_overrides read/write — SPEC-modulo-8-configuracion.md § 6.
 *
 * Panel-only capa: reads/writes the SAME `rate_overrides` rows
 * `calculatePrice.ts`/`calculateAvailability.ts` already consume. Never
 * touches those files (§ 1).
 *
 * "Volver al base" (§ 6.3): `price_cents`, `min_stay` and `units_available`
 * each accept an explicit `null` to clear that field back to base (JSON
 * distinguishes "field absent" from "field sent as null" — this module
 * relies on that distinction via `'key' in patch`, not `??`/`?.`).
 * `closed` has no "clear" state distinct from `false` (its own base value),
 * so it's a plain optional boolean. Once all four fields are back at base,
 * the row itself is deleted rather than kept as an empty husk.
 *
 * The cupo guard (§ 6.4) locks `rooms` FOR UPDATE — the exact same row
 * `createReservation`/`confirmPendingReservation` lock (see
 * availability/createReservation.ts) — BEFORE counting occupied units, so a
 * concurrent reservation being created for this room type can never leave
 * the guard's occupied-count stale (§ 7). No new lock primitive: this reuses
 * the mutex the engine already serializes new-reservation writes on.
 *
 * `closed` has NO guard (§ 6.4, § 6.7): a night can be closed (or reopened)
 * regardless of how many reservations already exist for it — closing never
 * de-books anyone, it only blocks NEW reservations. This applies uniformly
 * to `units_available` too: the guard compares the requested value against
 * the occupied count regardless of whether the night is also `closed`. A
 * closed night that still holds old reservations can have its
 * `units_available` guarded/rejected exactly like an open one — `closed`
 * only changes what `calculateAvailability` reports as the *effective* cupo
 * (forced to 0), it doesn't change what "occupied" means for this guard.
 * Kept uniform deliberately: special-casing `closed` here would let
 * `units_available` drift out of sync with reality the moment the night is
 * reopened, which is exactly the inconsistent state the guard exists to
 * prevent.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../db/types.js';
import { isReservationActive } from '../availability/isReservationActive.js';
import { addDaysUTC, eachNightUTC, formatDateUTC, parseDateUTC } from '../shared/dateUtils.js';

export class RoomNotFoundError extends Error {
  constructor() {
    super('Room not found');
  }
}

export class UnitsAvailableBelowOccupiedError extends Error {
  constructor(
    readonly date: string,
    readonly occupied: number,
    readonly requested: number,
  ) {
    super(`Cannot set units_available=${requested} for ${date}: ${occupied} unit(s) already occupied`);
  }
}

export interface RateOverrideRow {
  date: string;
  price_cents: number | null;
  min_stay: number | null;
  closed: boolean;
  units_available: number | null;
}

/** Fields patchable on a rate_overrides row. Absent = don't touch; null = clear to base (except `closed`). */
export interface RateOverridePatch {
  price_cents?: number | null;
  min_stay?: number | null;
  closed?: boolean;
  units_available?: number | null;
}

interface RateOverrideState {
  price_cents: number | null;
  min_stay: number | null;
  closed: boolean;
  units_available: number | null;
}

const BASE_STATE: RateOverrideState = { price_cents: null, min_stay: null, closed: false, units_available: null };

function mergePatch(existing: RateOverrideState | undefined, patch: RateOverridePatch): RateOverrideState {
  const base = existing ?? BASE_STATE;
  return {
    price_cents: 'price_cents' in patch ? (patch.price_cents ?? null) : base.price_cents,
    min_stay: 'min_stay' in patch ? (patch.min_stay ?? null) : base.min_stay,
    closed: patch.closed ?? base.closed,
    units_available: 'units_available' in patch ? (patch.units_available ?? null) : base.units_available,
  };
}

function isBaseState(state: RateOverrideState): boolean {
  return (
    state.price_cents === null && state.min_stay === null && state.closed === false && state.units_available === null
  );
}

/**
 * Count of active reservations (per `isReservationActive`) overlapping each
 * night in [from, toExclusive) for this room — same overlap definition
 * repository.ts's `fetchRoomStayData` uses for `occupiedByDate`, kept as a
 * separate, room-active-agnostic query here (deliberately not reused from
 * repository.ts — that function requires the room to be `active` and fetches
 * unrelated data this guard doesn't need; see this module's own doc comment).
 */
async function countOccupiedByDate(
  trx: Transaction<DB>,
  roomId: number,
  from: string,
  toExclusive: string,
): Promise<Record<string, number>> {
  const rows = await trx
    .selectFrom('reservations')
    .select([sql<string>`check_in::text`.as('check_in'), sql<string>`check_out::text`.as('check_out'), 'status', 'expires_at'])
    .where('room_id', '=', roomId)
    .where('check_in', '<', sql<Date>`${toExclusive}::date`)
    .where('check_out', '>', sql<Date>`${from}::date`)
    .where('status', '!=', 'cancelled')
    .execute();

  const occupiedByDate: Record<string, number> = {};
  for (const row of rows) {
    if (!isReservationActive(row.status, row.expires_at)) continue;
    const overlapStart = row.check_in > from ? row.check_in : from;
    const overlapEnd = row.check_out < toExclusive ? row.check_out : toExclusive;
    for (const night of eachNightUTC(overlapStart, overlapEnd)) {
      occupiedByDate[night] = (occupiedByDate[night] ?? 0) + 1;
    }
  }
  return occupiedByDate;
}

function toRow(date: string, state: RateOverrideState): RateOverrideRow {
  return { date, ...state };
}

export async function listRateOverrides(
  db: Kysely<DB>,
  input: { roomId: number; from: string; to: string },
): Promise<RateOverrideRow[]> {
  const rows = await db
    .selectFrom('rate_overrides')
    .select([sql<string>`date::text`.as('date'), 'price_cents', 'min_stay', 'closed', 'units_available'])
    .where('room_id', '=', input.roomId)
    .where('date', '>=', sql<Date>`${input.from}::date`)
    .where('date', '<=', sql<Date>`${input.to}::date`)
    .orderBy('date')
    .execute();

  return rows;
}

export interface PutRateOverrideInput extends RateOverridePatch {
  roomId: number;
  date: string;
}

export async function putRateOverride(db: Kysely<DB>, input: PutRateOverrideInput): Promise<RateOverrideRow> {
  return db.transaction().execute(async (trx) => {
    const room = await trx.selectFrom('rooms').select('id').where('id', '=', input.roomId).forUpdate().executeTakeFirst();
    if (!room) throw new RoomNotFoundError();

    const existing = await trx
      .selectFrom('rate_overrides')
      .select(['id', 'price_cents', 'min_stay', 'closed', 'units_available'])
      .where('room_id', '=', input.roomId)
      .where('date', '=', sql<Date>`${input.date}::date`)
      .executeTakeFirst();

    const next = mergePatch(existing, input);

    if (next.units_available !== null) {
      const nextDay = formatDateUTC(addDaysUTC(parseDateUTC(input.date), 1));
      const occupiedByDate = await countOccupiedByDate(trx, input.roomId, input.date, nextDay);
      const occupied = occupiedByDate[input.date] ?? 0;
      if (next.units_available < occupied) {
        throw new UnitsAvailableBelowOccupiedError(input.date, occupied, next.units_available);
      }
    }

    if (isBaseState(next)) {
      if (existing) await trx.deleteFrom('rate_overrides').where('id', '=', existing.id).execute();
      return toRow(input.date, next);
    }

    if (existing) {
      await trx.updateTable('rate_overrides').set(next).where('id', '=', existing.id).execute();
    } else {
      await trx
        .insertInto('rate_overrides')
        .values({ room_id: input.roomId, date: input.date, ...next })
        .execute();
    }

    return toRow(input.date, next);
  });
}

export interface ApplyRateOverridesRangeInput extends RateOverridePatch {
  roomId: number;
  from: string;
  /** Inclusive — unlike the checkIn/checkOut stay convention, this is a calendar range ("todo enero"). */
  to: string;
}

export interface ApplyRateOverridesRangeResult {
  /** Total nights in [from, to] — price_cents/min_stay/closed, when sent, are ALWAYS applied to all of them (§ 6.5). */
  nights: number;
  /** True when the patch touched price_cents, min_stay and/or closed. */
  priceMinStayClosedApplied: boolean;
  /** Present only when the patch touched units_available (§ 6.5's partial-application rule). */
  unitsAvailable: { appliedCount: number; failures: { date: string; occupied: number }[] } | null;
}

export async function applyRateOverridesRange(
  db: Kysely<DB>,
  input: ApplyRateOverridesRangeInput,
): Promise<ApplyRateOverridesRangeResult> {
  const dates = eachNightUTC(input.from, formatDateUTC(addDaysUTC(parseDateUTC(input.to), 1)));
  const touchesUnitsAvailable = 'units_available' in input;
  const touchesOthers = 'price_cents' in input || 'min_stay' in input || 'closed' in input;

  return db.transaction().execute(async (trx) => {
    const room = await trx.selectFrom('rooms').select('id').where('id', '=', input.roomId).forUpdate().executeTakeFirst();
    if (!room) throw new RoomNotFoundError();

    const occupiedByDate = touchesUnitsAvailable
      ? await countOccupiedByDate(trx, input.roomId, input.from, formatDateUTC(addDaysUTC(parseDateUTC(input.to), 1)))
      : {};

    const existingRows = await trx
      .selectFrom('rate_overrides')
      .select([sql<string>`date::text`.as('date'), 'id', 'price_cents', 'min_stay', 'closed', 'units_available'])
      .where('room_id', '=', input.roomId)
      .where('date', '>=', sql<Date>`${input.from}::date`)
      .where('date', '<=', sql<Date>`${input.to}::date`)
      .execute();
    const existingByDate = new Map(existingRows.map((row) => [row.date, row]));

    const failures: { date: string; occupied: number }[] = [];
    let unitsAvailableAppliedCount = 0;

    for (const date of dates) {
      const existing = existingByDate.get(date);
      const patchForNight: RateOverridePatch = { ...input };

      if (touchesUnitsAvailable) {
        const requested = input.units_available ?? null;
        const occupied = occupiedByDate[date] ?? 0;
        if (requested !== null && requested < occupied) {
          failures.push({ date, occupied });
          delete patchForNight.units_available;
        } else {
          unitsAvailableAppliedCount += 1;
        }
      }

      const next = mergePatch(existing, patchForNight);

      if (isBaseState(next)) {
        if (existing) await trx.deleteFrom('rate_overrides').where('id', '=', existing.id).execute();
        continue;
      }

      if (existing) {
        await trx.updateTable('rate_overrides').set(next).where('id', '=', existing.id).execute();
      } else {
        await trx
          .insertInto('rate_overrides')
          .values({ room_id: input.roomId, date, ...next })
          .execute();
      }
    }

    return {
      nights: dates.length,
      priceMinStayClosedApplied: touchesOthers,
      unitsAvailable: touchesUnitsAvailable ? { appliedCount: unitsAvailableAppliedCount, failures } : null,
    };
  });
}
