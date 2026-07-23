/**
 * Write actions for M7 panel reservations: register a payment, check-in,
 * check-out. Per SPEC-modulo-7-gestion-operativa.md § 5.4, § 6.
 *
 * None of these touch `reservation_nights` or disponibilidad, so — unlike
 * move/manual-creation (§ 4, § 7) — they don't need the advisory lock that
 * guards physical-unit integrity (§ 1's "NUNCA salteable" is about the
 * unit-night, not about money or status).
 */
import type { Kysely } from 'kysely';
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
const NOT_PAYABLE_STATUSES = new Set<ReservationStatus>(['cancelled', 'no_show', 'checked_out', 'payment_conflict']);

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

export interface ManualPaymentResult {
  method: 'cash' | 'external' | 'pix_manual';
  paymentId: number;
  status: 'received';
}

export type RegisterPaymentResult = PaymentDetails | ManualPaymentResult;

export interface RegisterPaymentInput {
  code: string;
  kind: AsaasPaymentKind;
  method: PanelPaymentMethod;
  amountCents: number;
  cpfCnpj?: string;
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
  const row = await db
    .insertInto('payments')
    .values({
      reservation_id: reservation.id,
      kind: input.kind,
      method: input.method,
      amount_cents: input.amountCents,
      status: 'received',
      changed_by: input.changedBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { method: input.method as 'cash' | 'external' | 'pix_manual', paymentId: row.id, status: 'received' };
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
  const reservation = await db
    .selectFrom('reservations')
    .select(['id', 'status'])
    .where('code', '=', input.code)
    .executeTakeFirst();

  if (!reservation) throw new ReservationNotFoundError();

  // Precondición 1 (§ 6.2): throws for anything other than
  // 'checked_in' -> 'checked_out'.
  assertValidTransition(reservation.status as ReservationStatus, 'checked_out');

  // Precondición 2 (§ 6.2, DURA — no warning-y-procedo): balance_due_cents
  // must be exactly 0. Checked AFTER the transition check so an invalid
  // status always reports as a transition error, not a balance error.
  const balance = await db
    .selectFrom('reservation_balances')
    .select('balance_due_cents')
    .where('reservation_id', '=', reservation.id)
    .executeTakeFirst();

  const balanceDueCents = Number(balance?.balance_due_cents ?? 0);
  if (balanceDueCents > 0) throw new BalanceDueError(balanceDueCents);

  await db
    .updateTable('reservations')
    .set({ status: 'checked_out', checked_out_at: new Date(), checked_out_by: input.changedBy })
    .where('id', '=', reservation.id)
    .execute();
}

export { InvalidReservationTransitionError };
