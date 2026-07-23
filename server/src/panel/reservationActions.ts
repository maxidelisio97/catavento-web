/**
 * Write actions for M7 panel reservations: register a payment, check-in,
 * check-out. Per SPEC-modulo-7-gestion-operativa.md § 5.4, § 6.
 *
 * None of these touch `reservation_nights` or disponibilidad, so — unlike
 * move/manual-creation (§ 4, § 7) — they don't need the advisory lock that
 * guards physical-unit integrity (§ 1's "NUNCA salteable" is about the
 * unit-night, not about money or status).
 */
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import {
  createOrReuseAsaasPayment,
  type AsaasPaymentKind,
  type PaymentDetails,
  type PaymentMethod as AsaasClientMethod,
} from '../reservations/createOrReusePayment.js';
import { assertValidTransition, InvalidReservationTransitionError, type ReservationStatus } from '../reservations/reservationStateMachine.js';
import { todayISO } from '../shared/dateUtils.js';

export type PanelPaymentMethod = 'asaas_pix' | 'asaas_card' | 'cash' | 'external' | 'pix_manual';

const ASAAS_METHODS = new Set<PanelPaymentMethod>(['asaas_pix', 'asaas_card']);

const ASAAS_METHOD_MAP: Record<'asaas_pix' | 'asaas_card', AsaasClientMethod> = {
  asaas_pix: 'pix',
  asaas_card: 'card',
};

// Terminal or dead-end states can't take a new payment — there's nothing
// left for the money to apply to. Not a rule stated verbatim in § 5, but a
// direct consequence of § 3's state machine (these states have no outgoing
// transitions a payment could ever unblock).
//
// `pending_payment` is included too (risk-review finding, not terminal but
// still excluded): a reservation in this state is still subject to the lazy
// expiry sweep (server/CLAUDE.md § 6A) — its `reservation_nights` rows can be
// released by another incoming reservation the moment its hold expires, even
// with a `received` payment already attached to it. Registering money against
// it here would silently orphan that payment. Confirming the reservation is
// a separate, explicit action (webhook for web reservations; there is no
// "confirm manual" endpoint yet, that's § 7 / M7D) — this endpoint must never
// do it as a side effect of taking money.
const NOT_PAYABLE_STATUSES = new Set<ReservationStatus>([
  'pending_payment',
  'cancelled',
  'no_show',
  'checked_out',
  'payment_conflict',
]);

export class ReservationNotFoundError extends Error {
  constructor() {
    super('Reservation not found');
  }
}

export class ReservationNotPayableError extends Error {
  constructor(readonly status: string) {
    super(`Reservation is '${status}', not payable`);
  }
}

export class MissingCpfCnpjError extends Error {
  constructor() {
    super('cpf_cnpj is required for asaas_pix/asaas_card payments');
  }
}

// Risk-review finding (§ 5.2 camino B): unlike the Asaas path — which dedupes
// via createOrReuseAsaasPayment's advisory lock + "reuse pending payment of
// this kind" lookup — a manual payment was a bare INSERT with no protection
// at all. Given the pousada's irregular connectivity, the realistic trigger
// isn't a double-click but a network retry: the operator submits, the
// connection hangs, they see no confirmation, and resubmit 15s later. Without
// this, that resubmit silently records the same cash payment twice — nothing
// else (no Asaas statement, no webhook) would ever catch the mismatch; it
// surfaces only when the guest has already left still owing the balance.
//
// The client generates `idempotencyKey` once per payment-form session (when
// the operator opens the form, not per submit) so repeated submits of the
// SAME intent reuse it, while closing and reopening the form to register a
// second, legitimately identical payment (e.g. two equal installments) gets
// a fresh key and is never merged.
export class MissingIdempotencyKeyError extends Error {
  constructor() {
    super('idempotency_key is required for cash/external/pix_manual payments');
  }
}

// Second risk-review finding on the fix above: the replay lookup matched
// only on (reservation_id, idempotency_key), so a key accidentally reused
// for a DIFFERENT payment (e.g. the operator edits the amount and resubmits
// after a hung request, without closing/reopening the form to mint a fresh
// key) silently returned the OLD payment as if the new one had been
// recorded — 200, no error, wrong amount on the ledger. A replay is only
// safe to treat as "the same intent" if kind/method/amount_cents match the
// original; if they don't, this is a genuinely different payment wearing a
// stale key, and must be rejected rather than silently substituted.
export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super('idempotency_key was already used for a different payment (kind/method/amount_cents mismatch)');
  }
}

export interface ManualPaymentResult {
  method: 'cash' | 'external' | 'pix_manual';
  paymentId: number;
  status: 'received';
  /** True when an existing payment with the same idempotency_key was returned instead of inserting a new one. */
  replayed: boolean;
}

export type RegisterPaymentResult = PaymentDetails | ManualPaymentResult;

export interface RegisterPaymentInput {
  code: string;
  kind: AsaasPaymentKind;
  method: PanelPaymentMethod;
  amountCents: number;
  cpfCnpj?: string;
  /** Required for cash/external/pix_manual (see MissingIdempotencyKeyError); ignored for asaas_* (already deduped upstream). */
  idempotencyKey?: string;
  changedBy: number;
}

export async function registerPayment(db: Kysely<DB>, input: RegisterPaymentInput): Promise<RegisterPaymentResult> {
  const reservation = await db
    .selectFrom('reservations')
    .select(['id', 'status', 'guest_name', 'guest_email', 'guest_phone'])
    .where('code', '=', input.code)
    .executeTakeFirst();

  if (!reservation) throw new ReservationNotFoundError();
  if (NOT_PAYABLE_STATUSES.has(reservation.status as ReservationStatus)) {
    throw new ReservationNotPayableError(reservation.status);
  }

  if (ASAAS_METHODS.has(input.method)) {
    if (!input.cpfCnpj) throw new MissingCpfCnpjError();

    return createOrReuseAsaasPayment(db, {
      reservationId: reservation.id,
      code: input.code,
      kind: input.kind,
      method: ASAAS_METHOD_MAP[input.method as 'asaas_pix' | 'asaas_card'],
      amountCents: input.amountCents,
      dueDate: todayISO(),
      guestName: reservation.guest_name ?? '',
      guestEmail: reservation.guest_email ?? '',
      guestPhone: reservation.guest_phone ?? '',
      cpfCnpj: input.cpfCnpj,
    });
  }

  // § 5.2 camino B: cash/external/pix_manual never touch Asaas — confirmed
  // in the act by the authority of the logged-in operator.
  if (!input.idempotencyKey) throw new MissingIdempotencyKeyError();
  const idempotencyKey = input.idempotencyKey;
  const method = input.method as 'cash' | 'external' | 'pix_manual';

  return db.transaction().execute(async (trx) => {
    // Advisory lock (same reservationId, same mechanism as
    // createOrReuseAsaasPayment) serializes concurrent requests for this
    // reservation so the dedupe lookup below is reliable — without it, two
    // near-simultaneous retries could both miss the SELECT before either has
    // committed its INSERT.
    await sql`SELECT pg_advisory_xact_lock(${reservation.id})`.execute(trx);

    const existing = await trx
      .selectFrom('payments')
      .select(['id', 'kind', 'method', 'amount_cents'])
      .where('reservation_id', '=', reservation.id)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();

    if (existing) {
      const sameIntent =
        existing.kind === input.kind && existing.method === input.method && existing.amount_cents === input.amountCents;
      if (!sameIntent) throw new IdempotencyKeyReusedError();
      return { method, paymentId: existing.id, status: 'received' as const, replayed: true };
    }

    const row = await trx
      .insertInto('payments')
      .values({
        reservation_id: reservation.id,
        kind: input.kind,
        method: input.method,
        amount_cents: input.amountCents,
        status: 'received',
        changed_by: input.changedBy,
        idempotency_key: idempotencyKey,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return { method, paymentId: row.id, status: 'received' as const, replayed: false };
  });
}

export interface CheckInInput {
  code: string;
  changedBy: number;
}

export async function checkIn(db: Kysely<DB>, input: CheckInInput): Promise<void> {
  const reservation = await db
    .selectFrom('reservations')
    .select(['id', 'status'])
    .where('code', '=', input.code)
    .executeTakeFirst();

  if (!reservation) throw new ReservationNotFoundError();

  // Throws InvalidReservationTransitionError (-> 409) for anything other
  // than 'confirmed' -> 'checked_in', per § 6.1's precondition.
  assertValidTransition(reservation.status as ReservationStatus, 'checked_in');

  await db
    .updateTable('reservations')
    .set({ status: 'checked_in', checked_in_at: new Date(), checked_in_by: input.changedBy })
    .where('id', '=', reservation.id)
    .execute();
}

export class BalanceDueError extends Error {
  constructor(readonly balanceDueCents: number) {
    super(`Cannot check out: balance due is ${balanceDueCents} cents`);
  }
}

export interface CheckOutInput {
  code: string;
  changedBy: number;
}

export async function checkOut(db: Kysely<DB>, input: CheckOutInput): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // Same pattern as the webhook (confirmPendingReservation.ts): lock the
    // reservation row first so a second concurrent check-out blocks here
    // instead of reading a stale status/balance snapshot. Risk-review found
    // that without this lock, two near-simultaneous check-out requests could
    // both read balance_due_cents == 0 and both pass, silently letting the
    // second overwrite checked_out_by/at — or worse, let one through after a
    // concurrent payment/extra had already changed the real balance.
    const reservation = await trx
      .selectFrom('reservations')
      .select(['id', 'status'])
      .where('code', '=', input.code)
      .forUpdate()
      .executeTakeFirst();

    if (!reservation) throw new ReservationNotFoundError();

    // Precondición 1 (§ 6.2): throws for anything other than
    // 'checked_in' -> 'checked_out'.
    assertValidTransition(reservation.status as ReservationStatus, 'checked_out');

    // Precondición 2 (§ 6.2, DURA — no warning-y-procedo): balance_due_cents
    // must be exactly 0. Checked AFTER the transition check so an invalid
    // status always reports as a transition error, not a balance error. Read
    // inside the same transaction, while the reservation row is locked, so
    // this reflects the balance at the instant we're about to commit the
    // transition — not a snapshot taken before some other writer landed.
    const balance = await trx
      .selectFrom('reservation_balances')
      .select('balance_due_cents')
      .where('reservation_id', '=', reservation.id)
      .executeTakeFirst();

    const balanceDueCents = Number(balance?.balance_due_cents ?? 0);
    if (balanceDueCents > 0) throw new BalanceDueError(balanceDueCents);

    // Guarded by status in the WHERE clause (not just id) as a second,
    // independent line of defense: even if the row lock above were ever
    // weakened or bypassed, an update that matches zero rows here means
    // someone else already moved this reservation out of 'checked_in', and
    // that must surface as a 409, never a silent no-op success.
    const result = await trx
      .updateTable('reservations')
      .set({ status: 'checked_out', checked_out_at: new Date(), checked_out_by: input.changedBy })
      .where('id', '=', reservation.id)
      .where('status', '=', 'checked_in')
      .executeTakeFirst();

    if (Number(result.numUpdatedRows) === 0) {
      throw new InvalidReservationTransitionError('checked_in', 'checked_out');
    }
  });
}

export { InvalidReservationTransitionError };
