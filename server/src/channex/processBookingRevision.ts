/**
 * Core Booking Revision processor, per SPEC-modulo-12B-reservas-entrantes.md
 * § 3.1. This is the ONLY place that turns a Channex booking revision into a
 * local write — both the webhook (§ 3.2) and the pull (§ 3.4) call this
 * SAME function (§ 7: "no duplicar lógica de crear/modificar/cancelar entre
 * los dos caminos").
 *
 * Scope note (flagged, not silently narrowed): this module handles ONE room
 * line per booking. A Channex booking can in principle carry `rooms: [...]`
 * with more than one room type in a single reservation — the spec's step 1
 * ("resolver channex_room_type_id de cada rooms[]") reads as plural, but
 * step 3 calls `createReservation()` singular and never resolves how a
 * multi-room booking maps to our one-room-type-per-reservation model. Given
 * a 3-room-type pousada, this is a rare case, not the common one — so rather
 * than guess at semantics the spec doesn't settle, a booking with more than
 * one room line returns `multi_room_unsupported` and is logged, never
 * silently mishandled. Confirm with Maxi/Channex behavior before deciding
 * how to split it (N local reservations vs. something else) if this outcome
 * ever fires for real.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../db/types.js';
import { createReservationWithCode } from '../reservations/createReservationWithCode.js';
import { NoAvailabilityError } from '../availability/createReservation.js';
import { calculateCombinedAvailability } from '../availability/combinedAvailability.js';
import { fetchRoomStayData } from '../availability/repository.js';
import { sweepStaleReservationNights } from '../availability/sweepStaleReservationNights.js';
import { releaseReservationNights } from '../availability/releaseReservationNights.js';
import { assertReservationNightsConsistency } from '../availability/checkReservationNightsConsistency.js';
import { eachNightUTC } from '../shared/dateUtils.js';
import { generateReservationCode } from '../reservations/generateCode.js';
import { findRoomIdByChannexRoomTypeId } from './channexRoomTypeMap.js';
import { assertValidTransition, isValidTransition, type ReservationStatus } from '../reservations/reservationStateMachine.js';

/**
 * Normalized shape this module actually needs — deliberately NOT the raw
 * Channex JSON:API payload. Mapping the real webhook/feed body into this
 * shape is `parseChannexBookingRevision`'s job (channexPayload.ts), kept
 * separate so a field-name mismatch found against a real staging payload is
 * a one-file fix, not a hunt through this module's transaction logic.
 */
export interface ChannexBookingRevisionInput {
  bookingId: string;
  revisionId: string;
  status: 'new' | 'modified' | 'cancelled';
  /** Present for 'new'/'modified'; irrelevant for 'cancelled'. */
  channexRoomTypeId?: string;
  checkIn?: string;
  checkOut?: string;
  guests?: number;
  guestName?: string;
  guestEmail?: string;
  guestPhone?: string;
  /** Total amount for the stay, as Channex reports it, in cents. */
  amountCents?: number;
  /** True when the booking carries more than one room line (see module docstring). */
  multiRoom?: boolean;
}

export type ProcessBookingRevisionOutcome =
  | { kind: 'noop_idempotent' }
  | { kind: 'multi_room_unsupported' }
  | { kind: 'unmapped_room_type' }
  | { kind: 'cancelled_unknown_booking' }
  | { kind: 'created'; reservationId: number }
  | { kind: 'modified'; reservationId: number }
  | { kind: 'cancelled'; reservationId: number }
  | { kind: 'conflict'; reservationId: number };

interface ExistingReservationRow {
  id: number;
  status: string;
  channex_last_revision_id: string | null;
}

async function findExistingByBookingId(db: Kysely<DB>, bookingId: string): Promise<ExistingReservationRow | undefined> {
  return db
    .selectFrom('reservations')
    .select(['id', 'status', 'channex_last_revision_id'])
    .where('channex_booking_id', '=', bookingId)
    .executeTakeFirst();
}

// Arbitrary namespace for the two-int advisory-lock form below — only needs
// to be stable and unique to this call site (see the lock's own comment).
const BOOKING_LOCK_NAMESPACE = 1200;

export async function processBookingRevision(
  db: Kysely<DB>,
  input: ChannexBookingRevisionInput,
): Promise<ProcessBookingRevisionOutcome> {
  if (input.multiRoom) {
    return { kind: 'multi_room_unsupported' };
  }

  // Risk-review finding (pre-merge, fresh-context review): the webhook and
  // the pull can both deliver the SAME booking's first ('new') revision
  // concurrently (a live delivery racing a manual pull, or two webhook
  // retries) — a plain check-then-act on `channex_booking_id` let both
  // callers see "no existing reservation" and both attempt to create one,
  // producing a phantom `ota_conflict` for a booking the other call already
  // handled successfully. Everything below now runs inside ONE transaction
  // holding a `channex_booking_id`-keyed advisory lock, so the entire
  // read-decide-write sequence for a given booking is atomic across both
  // delivery paths.
  //
  // Two-argument form `(namespace, hashtext(bookingId))` deliberately used
  // instead of the single-bigint form the rest of this codebase uses for
  // reservation-level locks (e.g. `pg_advisory_xact_lock(reservationId)`):
  // Postgres advisory locks share ONE 64-bit keyspace across every caller in
  // the session, and hashtext's 32-bit output could — astronomically
  // unlikely, but not impossible — collide with a small integer
  // reservationId already locked elsewhere. The two-int form is a
  // completely separate lock space from the single-bigint form, which
  // eliminates that cross-domain collision risk outright.
  return db.transaction().execute((trx) => runProcessBookingRevision(trx, input));
}

async function runProcessBookingRevision(
  trx: Transaction<DB>,
  input: ChannexBookingRevisionInput,
): Promise<ProcessBookingRevisionOutcome> {
  await sql`SELECT pg_advisory_xact_lock(${BOOKING_LOCK_NAMESPACE}, hashtext(${input.bookingId}))`.execute(trx);

  const existing = await findExistingByBookingId(trx, input.bookingId);

  // Idempotency (§ 1.1): this exact revision was already applied — whether
  // by an earlier webhook delivery or a previous pull pass over the same
  // feed entry. Safe to check now that it's under the booking-level lock —
  // no other call for this SAME booking can be mid-write concurrently.
  if (existing && existing.channex_last_revision_id === input.revisionId) {
    return { kind: 'noop_idempotent' };
  }

  if (input.status === 'cancelled') {
    return processCancellation(trx, existing, input);
  }

  if (!input.channexRoomTypeId || !input.checkIn || !input.checkOut || input.guests === undefined) {
    throw new Error('new/modified booking revision missing required fields (room type, dates, guests)');
  }
  const roomId = await findRoomIdByChannexRoomTypeId(trx, input.channexRoomTypeId);
  if (roomId === null) {
    return { kind: 'unmapped_room_type' };
  }

  if (!existing) {
    return processNewBooking(trx, roomId, input);
  }
  return processModification(trx, existing, roomId, input);
}

async function processCancellation(
  trx: Transaction<DB>,
  existing: ExistingReservationRow | undefined,
  input: ChannexBookingRevisionInput,
): Promise<ProcessBookingRevisionOutcome> {
  if (!existing) {
    // Nothing local to cancel — logged by the caller (webhook/pull), not an
    // error: a cancellation for a booking we never created (e.g. it was
    // cancelled before its 'new' revision was ever processed) is a valid
    // outcome, not a bug.
    return { kind: 'cancelled_unknown_booking' };
  }

  // Same `pg_advisory_xact_lock(reservationId)` pattern as
  // cancelReservation.ts/moveReservation.ts — serializes against a
  // concurrent PANEL action on the SAME reservation (the booking-level lock
  // above only serializes concurrent Channex deliveries, a different actor).
  await sql`SELECT pg_advisory_xact_lock(${existing.id})`.execute(trx);

  const fresh = await trx
    .selectFrom('reservations')
    .select(['id', 'status'])
    .where('id', '=', existing.id)
    .executeTakeFirstOrThrow();

  if (fresh.status !== 'cancelled' && isValidTransition(fresh.status as ReservationStatus, 'cancelled')) {
    await trx
      .updateTable('reservations')
      .set({ status: 'cancelled', cancelled_at: new Date(), cancel_reason: 'Cancelado pela OTA (Channex)' })
      .where('id', '=', fresh.id)
      .execute();

    await releaseReservationNights(trx, fresh.id);
    await assertReservationNightsConsistency(trx, fresh.id);
  }
  // Anything else (already checked_in/checked_out, or already cancelled):
  // nothing to release, but the revision must still be recorded as
  // processed so it doesn't get retried forever.

  await trx
    .updateTable('reservations')
    .set({ channex_last_revision_id: input.revisionId })
    .where('id', '=', fresh.id)
    .execute();

  return { kind: 'cancelled', reservationId: fresh.id };
}

async function processNewBooking(
  trx: Transaction<DB>,
  roomId: number,
  input: ChannexBookingRevisionInput,
): Promise<ProcessBookingRevisionOutcome> {
  try {
    // createReservation detects `trx.isTransaction` and reuses it instead of
    // nesting a new one — see createReservation.ts's own comment.
    const result = await createReservationWithCode(trx, {
      roomId,
      checkIn: input.checkIn as string,
      checkOut: input.checkOut as string,
      guests: input.guests as number,
      guestName: input.guestName,
      guestEmail: input.guestEmail,
      guestPhone: input.guestPhone,
      origin: 'ota',
      status: 'confirmed',
      overrideTotalCents: input.amountCents,
      channexBookingId: input.bookingId,
      channexLastRevisionId: input.revisionId,
    });
    return { kind: 'created', reservationId: result.id };
  } catch (err) {
    if (err instanceof NoAvailabilityError) {
      const reservationId = await insertOtaConflict(trx, roomId, input);
      return { kind: 'conflict', reservationId };
    }
    throw err;
  }
}

/** § 3.1 step 4: no reservation_nights rows — same shape as `payment_conflict` (M4), never a fabricated unit. */
async function insertOtaConflict(trx: Transaction<DB>, roomId: number, input: ChannexBookingRevisionInput): Promise<number> {
  const MAX_CODE_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    try {
      const row = await trx
        .insertInto('reservations')
        .values({
          room_id: roomId,
          room_unit_id: null,
          check_in: input.checkIn as string,
          check_out: input.checkOut as string,
          guests: input.guests as number,
          status: 'ota_conflict',
          total_cents: input.amountCents ?? 0,
          override_total_cents: input.amountCents ?? null,
          guest_name: input.guestName ?? null,
          guest_email: input.guestEmail ?? null,
          guest_phone: input.guestPhone ?? null,
          origin: 'ota',
          created_by: null,
          code: generateReservationCode(),
          channex_booking_id: input.bookingId,
          channex_last_revision_id: input.revisionId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    } catch (err) {
      if (!isCodeUniqueViolation(err)) throw err;
    }
  }
  throw new Error('Could not generate a unique reservation code for an ota_conflict row after 3 attempts');
}

interface PgUniqueViolation {
  code: string;
  constraint?: string;
}

function isCodeUniqueViolation(err: unknown): err is PgUniqueViolation {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as PgUniqueViolation).code === '23505' &&
    ((err as PgUniqueViolation).constraint?.includes('code') ?? false)
  );
}

export interface ReassignOtaReservationInput {
  reservationId: number;
  roomId: number;
  checkIn: string;
  checkOut: string;
  guests: number;
  amountCents: number | null;
  guestName?: string | null;
  guestEmail?: string | null;
  guestPhone?: string | null;
  /** Omit for a conflict retry (§ 3.5) — the revision itself didn't change. */
  channexRevisionId?: string;
}

/**
 * § 3.1 step 3 (modified) + § 3.5 (conflict retry, reused): re-runs the same
 * "lock room, sweep, recompute availability, (re)assign nights" sequence
 * `createReservation`/`confirmPendingReservation` use, but writing into an
 * EXISTING reservation row instead of inserting a new one — there is no
 * existing function for "reassign an existing reservation to possibly new
 * dates/room", so this mirrors that established pattern rather than
 * reimplementing it from scratch.
 *
 * Everything — the advisory lock, the room lock, the sweep, the
 * nights write, AND the reservations row's status/fields update — happens
 * in ONE transaction. Splitting "assign nights" and "update status" across
 * two transactions would reopen exactly the race this project's locking
 * discipline exists to close: another concurrent write could land on this
 * reservation between the two commits and observe (or act on) a
 * nights/status combination that never should have existed as a persisted
 * state.
 */
export async function reassignOtaReservation(
  db: Kysely<DB>,
  input: ReassignOtaReservationInput,
): Promise<{ available: boolean }> {
  // Same reentrancy as createReservation.ts: processModification (below)
  // calls this already holding the outer per-booking transaction/lock from
  // processBookingRevision; the standalone conflict-retry caller
  // (panel/otaConflicts.ts) passes a plain `db` and gets its own transaction
  // opened here as before.
  if (db.isTransaction) {
    return runReassignOtaReservation(db as Transaction<DB>, input);
  }
  return db.transaction().execute((trx) => runReassignOtaReservation(trx, input));
}

async function runReassignOtaReservation(
  trx: Transaction<DB>,
  input: ReassignOtaReservationInput,
): Promise<{ available: boolean }> {
  const { reservationId, roomId, checkIn, checkOut } = input;

  {
    await sql`SELECT pg_advisory_xact_lock(${reservationId})`.execute(trx);

    const fresh = await trx
      .selectFrom('reservations')
      .select('status')
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();

    const room = await trx
      .selectFrom('rooms')
      .select('id')
      .where('id', '=', roomId)
      .where('active', '=', true)
      .forUpdate()
      .executeTakeFirst();

    let available = false;
    let chosenUnitId: number | undefined;

    if (room) {
      await sweepStaleReservationNights(trx, roomId, checkIn, checkOut);

      const stayData = await fetchRoomStayData(trx, roomId, checkIn, checkOut, reservationId);
      const availability = stayData
        ? calculateCombinedAvailability({
            checkIn,
            checkOut,
            totalUnits: stayData.totalUnits,
            overrides: stayData.overrides,
            occupiedByDate: stayData.occupiedByDate,
            // § 0.2: this function only ever reassigns an OTA reservation
            // (modification or conflict retry) — always skip, same reasoning
            // as createReservation.ts's own skipClosedCheck.
            skipClosedCheck: true,
            units: stayData.roomUnits,
            unitReservations: stayData.unitReservations,
          })
        : { available: false, nights: [], unitsLeft: 0, freeUnits: [] };

      available = availability.available && !!availability.freeUnits[0];
      chosenUnitId = availability.freeUnits[0]?.id;
    }

    await releaseReservationNights(trx, reservationId);

    if (available && chosenUnitId !== undefined) {
      await trx
        .insertInto('reservation_nights')
        .values(
          eachNightUTC(checkIn, checkOut).map((night) => ({
            reservation_id: reservationId,
            night,
            room_unit_id: chosenUnitId as number,
          })),
        )
        .execute();
    }

    const newStatus: ReservationStatus = available ? 'confirmed' : 'ota_conflict';
    if (fresh.status !== newStatus) {
      assertValidTransition(fresh.status as ReservationStatus, newStatus);
    }

    await trx
      .updateTable('reservations')
      .set({
        room_id: roomId,
        check_in: checkIn,
        check_out: checkOut,
        guests: input.guests,
        status: newStatus,
        total_cents: input.amountCents ?? 0,
        override_total_cents: input.amountCents ?? null,
        guest_name: input.guestName ?? null,
        guest_email: input.guestEmail ?? null,
        guest_phone: input.guestPhone ?? null,
        ...(input.channexRevisionId !== undefined ? { channex_last_revision_id: input.channexRevisionId } : {}),
      })
      .where('id', '=', reservationId)
      .execute();

    await assertReservationNightsConsistency(trx, reservationId);
    return { available };
  }
}

async function processModification(
  trx: Transaction<DB>,
  existing: ExistingReservationRow,
  roomId: number,
  input: ChannexBookingRevisionInput,
): Promise<ProcessBookingRevisionOutcome> {
  // Terminal/operational states (checked_in, checked_out, no_show) are never
  // mutated by an OTA modification — the guest's actual stay already
  // happened or is in progress locally, and re-dating it out from under
  // check-in/out would corrupt operational history. Only 'confirmed' and
  // 'ota_conflict' are live enough to still mean "this hasn't happened yet".
  if (existing.status !== 'confirmed' && existing.status !== 'ota_conflict') {
    await trx
      .updateTable('reservations')
      .set({ channex_last_revision_id: input.revisionId })
      .where('id', '=', existing.id)
      .execute();
    return { kind: existing.status === 'cancelled' ? 'cancelled' : 'modified', reservationId: existing.id };
  }

  const { available } = await reassignOtaReservation(trx, {
    reservationId: existing.id,
    roomId,
    checkIn: input.checkIn as string,
    checkOut: input.checkOut as string,
    guests: input.guests as number,
    amountCents: input.amountCents ?? null,
    guestName: input.guestName,
    guestEmail: input.guestEmail,
    guestPhone: input.guestPhone,
    channexRevisionId: input.revisionId,
  });

  return { kind: available ? 'modified' : 'conflict', reservationId: existing.id };
}
