/**
 * Confirms a reservation once its deposit payment has been verified by an
 * Asaas webhook, per SPEC-modulo-4-pago-asaas.md § "Webhook Asaas".
 *
 * Runs inside the same anti-overbooking transaction pattern as módulo 2's
 * createReservation: lock the room row, re-check availability, then decide.
 * The "caso límite" (payment lands after expires_at): if a physical unit is
 * still free for the whole stay, confirm anyway (the guest paid, there's
 * room) and (re)write its `reservation_nights` rows; if not, the reservation
 * moves to `payment_conflict` instead of double-booking the unit — refunds
 * are handled manually for now (módulo 5 will surface these).
 *
 * Módulo 6A note: the re-check MUST be per-unit
 * (`calculateCombinedAvailability`), not just the aggregate
 * `calculateAvailability`. A pending hold that already expired can have had
 * its `reservation_nights` rows deleted by another transaction's lazy sweep
 * (sweepStaleReservationNights.ts) in the meantime — the aggregate check
 * alone can't tell whether a physical unit is actually still free for this
 * exact reservation, and confirming without restoring its rows would leave
 * an active reservation with zero units assigned, breaking the § 6A.3
 * invariant. `fetchRoomStayData`'s `excludeReservationId` already ignores
 * this reservation's own (possibly stale, possibly absent) rows, so
 * `freeUnits` reflects everyone ELSE'S occupancy — exactly what's needed to
 * decide "is there still a unit for it", regardless of what state this
 * reservation's own rows happen to be in right now.
 */

import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../db/types.js';
import { calculateCombinedAvailability } from './combinedAvailability.js';
import { fetchRoomStayData } from './repository.js';
import { releaseReservationNights } from './releaseReservationNights.js';
import { eachNightUTC } from '../shared/dateUtils.js';
import { assertReservationNightsConsistency } from './checkReservationNightsConsistency.js';

export type ConfirmOutcome =
  /** Payment row didn't exist locally — nothing to do (ack the webhook anyway). */
  | { kind: 'unknown_payment' }
  /** Same event/status already fully processed — no side effects applied. */
  | { kind: 'noop_idempotent' }
  /** Payment marked received, but the reservation was already settled by another path. */
  | { kind: 'payment_marked_received_only'; reservationId: number; reservationStatus: string; overpaymentFlagged: boolean }
  /** Reservation moved pending_payment -> confirmed. */
  | { kind: 'confirmed'; reservationId: number; overpaymentFlagged: boolean }
  /** Reservation moved pending_payment -> payment_conflict (see module docstring). */
  | { kind: 'payment_conflict'; reservationId: number; overpaymentFlagged: boolean };

export interface ProcessPaymentReceivedInput {
  asaasPaymentId: string;
  rawEvent: unknown;
}

export async function processPaymentReceived(
  db: Kysely<DB>,
  input: ProcessPaymentReceivedInput,
): Promise<ConfirmOutcome> {
  // Reentrancy: overpaymentGuard.ts's reconciliation calls this from INSIDE
  // its own already-open transaction — a stale pending Asaas payment that
  // Asaas actually confirmed needs to go through the SAME confirmation +
  // overpayment-flag logic a live webhook gets, not just a status flip (see
  // overpaymentGuard.ts's docstring for why the bare UPDATE it used to do
  // was itself a money/state desync bug). Kysely refuses to open a
  // transaction on top of an existing one — `db.transaction()` throws if
  // `db` is already a `Transaction` — so branch on `db.isTransaction` and
  // reuse the caller's transaction directly instead of nesting one. This
  // makes a reconciliation-triggered confirmation part of the SAME atomic
  // unit as whatever operation (a new charge, a manual payment) triggered
  // the reconciliation: if it fails, that operation rolls back too, instead
  // of silently leaving the ledger half-fixed.
  if (db.isTransaction) {
    return runProcessPaymentReceived(db as Transaction<DB>, input);
  }
  return db.transaction().execute((trx) => runProcessPaymentReceived(trx, input));
}

async function runProcessPaymentReceived(
  trx: Transaction<DB>,
  input: ProcessPaymentReceivedInput,
): Promise<ConfirmOutcome> {
  const payment = await trx
    .selectFrom('payments')
    .selectAll()
    .where('asaas_payment_id', '=', input.asaasPaymentId)
    .forUpdate()
    .executeTakeFirst();

  if (!payment) {
    return { kind: 'unknown_payment' };
  }

  // Lock the reservation row itself so a duplicate/near-simultaneous
  // webhook delivery can't race this one.
  const reservation = await trx
    .selectFrom('reservations')
    .select([
      'id',
      'room_id',
      'status',
      sql<string>`check_in::text`.as('check_in'),
      sql<string>`check_out::text`.as('check_out'),
    ])
    .where('id', '=', payment.reservation_id)
    .forUpdate()
    .executeTakeFirst();

  if (!reservation) {
    return { kind: 'unknown_payment' };
  }

  const alreadyReceived = payment.status === 'received';
  // SPEC-modulo-7-gestion-operativa.md § 5.2: M7 adds `kind='balance'`
  // payments (and 'extra') that can arrive here via the same webhook. Only
  // a `deposit` payment is allowed to drive the pending_payment -> confirmed
  // transition below — a balance/extra payment must NEVER re-trigger
  // confirmation, even if it happened to land while the reservation was
  // (implausibly) still pending_payment. This is deliberately keyed off
  // `payment.kind`, not `reservation.status`, per the spec's explicit
  // warning: the discriminator is "which payment is this", not "what state
  // is the reservation in" — the latter is a coincidence of M4's flow
  // (deposit always precedes confirmation), not a guarantee.
  const drivesConfirmation = payment.kind === 'deposit';
  const reservationSettled = reservation.status !== 'pending_payment';

  if (alreadyReceived && (reservationSettled || !drivesConfirmation)) {
    // Idempotency: this exact outcome was already applied by a previous
    // delivery of this (or an equivalent) webhook event.
    return { kind: 'noop_idempotent' };
  }

  let overpaymentFlagged = false;

  if (!alreadyReceived) {
    await trx
      .updateTable('payments')
      .set({
        status: 'received',
        received_at: new Date(),
        raw_last_event: JSON.stringify(input.rawEvent),
        updated_at: new Date(),
      })
      .where('id', '=', payment.id)
      .execute();

    // Risk-review finding (fix-asaas-overpayment-webhook): by the time this
    // webhook fires, the money is already captured by Asaas — there's no
    // refund endpoint to undo it, so rejecting here can't prevent an
    // overpayment, it would only desync our ledger from what Asaas
    // actually holds. Real prevention happens at charge-creation time
    // (overpaymentGuard.ts, checked under the advisory lock before a
    // charge is ever created). This is the last-resort net for whatever
    // slips past that — flag, don't reject, so it surfaces for a manual
    // refund instead of silently sitting on the ledger.
    const balance = await trx
      .selectFrom('reservation_balances')
      .select('balance_due_cents')
      .where('reservation_id', '=', reservation.id)
      .executeTakeFirst();
    const balanceDueCents = Number(balance?.balance_due_cents ?? 0);

    if (balanceDueCents < 0) {
      overpaymentFlagged = true;
      // Excess is snapshotted now, not recomputed later: reservation_balances
      // is a live view, and by the time anyone reviews this flagged payment
      // another payment or extra may have already changed balance_due_cents.
      await trx
        .updateTable('payments')
        .set({
          flagged_overpayment: true,
          flagged_overpayment_at: new Date(),
          flagged_overpayment_excess_cents: -balanceDueCents,
        })
        .where('id', '=', payment.id)
        .execute();
    }
  }

  if (reservationSettled || !drivesConfirmation) {
    // Either the reservation was already confirmed/cancelled/payment_conflict
    // by another path (e.g. a previous webhook delivery that crashed after
    // updating the payment but before this point), or this payment is a
    // balance/extra that must only ever record money, never drive a state
    // transition. Nothing more to do — the balance itself is derived from
    // `reservation_balances`, not recalculated here.
    return {
      kind: 'payment_marked_received_only',
      reservationId: reservation.id,
      reservationStatus: reservation.status,
      overpaymentFlagged,
    };
  }

  // Re-lock the room and recompute availability excluding this
  // reservation's own occupancy, so we're checking "is there still room
  // for it", not "does it collide with itself".
  const room = await trx
    .selectFrom('rooms')
    .select('id')
    .where('id', '=', reservation.room_id)
    .forUpdate()
    .executeTakeFirst();

  const checkIn = reservation.check_in;
  const checkOut = reservation.check_out;

  const stayData = room
    ? await fetchRoomStayData(trx, reservation.room_id, checkIn, checkOut, reservation.id)
    : undefined;

  const availability = stayData
    ? calculateCombinedAvailability({
        checkIn,
        checkOut,
        totalUnits: stayData.totalUnits,
        overrides: stayData.overrides,
        occupiedByDate: stayData.occupiedByDate,
        units: stayData.roomUnits,
        unitReservations: stayData.unitReservations,
      })
    : { available: false, nights: [], unitsLeft: 0, freeUnits: [] };

  const chosenUnit = availability.available ? availability.freeUnits[0] : undefined;

  if (availability.available && chosenUnit) {
    // Restore this reservation's reservation_nights from scratch rather
    // than trying to diff against whatever partial/stale state they're
    // currently in (0 rows if swept, all of them if untouched, anything
    // in between is not expected but not worth reasoning about either) —
    // delete-then-reinsert is simple and always correct here.
    await releaseReservationNights(trx, reservation.id);
    await trx
      .insertInto('reservation_nights')
      .values(
        eachNightUTC(checkIn, checkOut).map((night) => ({
          reservation_id: reservation.id,
          night,
          room_unit_id: chosenUnit.id,
        })),
      )
      .execute();

    await trx
      .updateTable('reservations')
      .set({ status: 'confirmed', room_unit_id: chosenUnit.id })
      .where('id', '=', reservation.id)
      .execute();

    await assertReservationNightsConsistency(trx, reservation.id);

    return { kind: 'confirmed', reservationId: reservation.id, overpaymentFlagged };
  }

  await trx
    .updateTable('reservations')
    .set({ status: 'payment_conflict' })
    .where('id', '=', reservation.id)
    .execute();

  // Módulo 6A: the reservation no longer occupies inventory once it's
  // marked payment_conflict, so its reservation_nights rows must go too —
  // otherwise the unit would stay "occupied" in the per-night model
  // forever, with nothing left to ever release it (unlike a normal
  // pending_payment expiry, which the lazy sweep picks up on the next
  // createReservation for that room). A future cancellation flow (M7)
  // must call this SAME function rather than reimplementing the delete.
  await releaseReservationNights(trx, reservation.id);

  await assertReservationNightsConsistency(trx, reservation.id);

  return { kind: 'payment_conflict', reservationId: reservation.id, overpaymentFlagged };
}
