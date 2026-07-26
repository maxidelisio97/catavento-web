/**
 * Overpayment prevention shared by both payment-creation paths, per the
 * risk-review finding on fix-checkin-lock-and-overpayment: validating only
 * against `reservation_balances` (RECEIVED payments) at charge-creation
 * time isn't enough for Asaas — a charge sits `pending` until its webhook
 * lands, so two charges of DIFFERENT `kind` (e.g. deposit + balance) can
 * each individually pass the check while both are still pending, then both
 * get paid and confirmed with nothing to catch the double collection. No
 * thread race required — two sequential requests, minutes apart, are enough.
 *
 * Lives in its own module (not in panel/reservationActions.ts, where the
 * cash-only version used to live) because BOTH registerPayment
 * (reservationActions.ts) and createOrReuseAsaasPayment
 * (createOrReusePayment.ts) need it, and reservationActions.ts already
 * imports createOrReuseAsaasPayment — putting these here avoids a circular
 * import between the two.
 *
 * IMPORTANT — a DB constraint already exists that overlaps with this, easy
 * to miss (it was missed on the first pass at this fix, found only by doing
 * the mandatory "remove the guard, confirm the test fails" check):
 * `idx_payments_one_pending_per_reservation` (migration 1784587500000) is a
 * UNIQUE index on `payments.reservation_id WHERE status='pending'` — NOT
 * scoped by `kind`. It already forbids two simultaneously-pending payments
 * of ANY kind for the same reservation at the DB level. So for a PURE
 * Asaas-vs-Asaas double-pending attempt, the money was already safe before
 * this guard existed — without assertNotOverpayingWithPendingAsaas, the
 * second createOrReuseAsaasPayment's INSERT would still fail, just as a raw
 * unhandled 500 (unique-violation) instead of a clean OverpaymentError/422.
 * That index does NOT help against the mixed case, though: a `cash`
 * payment inserts straight to `received`, never `pending`, so the index
 * never sees it — a pending Asaas charge plus a `received` cash payment
 * that together exceed the total is NOT caught by the index in either
 * order. That mixed case is what this module actually exists to close.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../db/types.js';
import { getPayment } from '../asaasClient.js';
import { processPaymentReceived } from '../availability/confirmPendingReservation.js';

export class OverpaymentError extends Error {
  constructor(
    readonly balanceDueCents: number,
    readonly attemptedAmountCents: number,
  ) {
    super(`Payment of ${attemptedAmountCents} cents exceeds balance due of ${balanceDueCents} cents`);
  }
}

/** Asaas statuses that mean "money has moved" (received or on its way to us) — same set createOrReusePayment.ts uses. */
const RECEIVED_LIKE_STATUSES = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);

/**
 * Cheap pre-check against `reservation_balances` (RECEIVED payments only) —
 * no lock, no Asaas calls. Rejects the obvious typo'd-amount mistake before
 * opening a transaction or touching Asaas. Does NOT close the cross-kind
 * pending-Asaas gap on its own — that's what assertNotOverpayingWithPendingAsaas
 * (below) is for, called under the advisory lock right before a charge is
 * actually created.
 */
export async function assertNotOverpaying(db: Kysely<DB>, reservationId: number, amountCents: number): Promise<void> {
  const balance = await db
    .selectFrom('reservation_balances')
    .select('balance_due_cents')
    .where('reservation_id', '=', reservationId)
    .executeTakeFirst();

  // Paying exactly the balance is the normal "closes it to zero" case;
  // one cent over is rejected, never clamped.
  const balanceDueCents = Number(balance?.balance_due_cents ?? 0);
  if (amountCents > balanceDueCents) {
    throw new OverpaymentError(balanceDueCents, amountCents);
  }
}

/**
 * Reconciles `pending` Asaas payments (any kind) that are old enough to
 * plausibly have expired — `created_at < current_date` — against their real
 * Asaas status, so a dangling pending row from a different kind doesn't
 * either (a) silently inflate the "money at risk" sum and block a
 * legitimate new charge, or (b) get marked `failed` when Asaas actually DID
 * receive it (a lost/delayed webhook), which would hide real money from
 * `reservation_balances` and make the balance look bigger than it is —
 * exactly the kind of bug this whole fix exists to prevent.
 *
 * Bounded cost: a charge is created with `dueDate` = today, so `created_at`'s
 * date IS the due date — a row created today is never touched here (no
 * remote call), it's trusted as still legitimately outstanding. Only a
 * genuinely stale leftover pays the cost of one `getPayment` call. In the
 * normal flow (one charge per kind per day) this runs zero Asaas requests.
 *
 * Same 3-way branch createOrReusePayment.ts's same-kind reconciliation uses
 * (PENDING/AWAITING_RISK_ANALYSIS stays pending; RECEIVED-like -> received;
 * anything else -> failed) — deliberately NOT the 2-way "pending or failed"
 * a naive read of the plan would suggest, and deliberately NOT throwing
 * PaymentAlreadyReceivedError: that error means "you're trying to reuse
 * THIS exact charge for your current request", which doesn't apply here —
 * this is just cleaning up stale rows of OTHER kinds before summing.
 *
 * Risk-review finding on fix-asaas-overpayment-webhook itself: the
 * RECEIVED-like branch used to be a bare `UPDATE ... SET status='received'`,
 * bypassing the entire confirmation state machine AND the overpayment-flag
 * check in `processPaymentReceived` — meaning reconciliation could silently
 * confirm money was received without ever confirming the reservation (a
 * stale deposit) or flagging an overpayment it just revealed (any kind).
 * That's the same class of money/state desync this whole fix exists to
 * close, reopened by the fix's own cleanup step. Now routed through
 * `processPaymentReceived(trx, ...)` — same function the real webhook uses,
 * called with `trx` (NOT the outer `db`) so it detects `db.isTransaction`
 * and reuses THIS transaction directly instead of opening a second,
 * independently-committing one (Kysely refuses `trx.transaction()` on an
 * already-open transaction — there's no silent nesting to get wrong here).
 * Passing `db` here would be wrong: it would open a new pool connection,
 * losing the "runs under the same lock" guarantee and letting the
 * reconciled row become visible to other sessions before the caller's own
 * transaction (the one deciding whether to allow a new charge) commits.
 * Errors propagate — a failed reconciliation aborts the attempt to register
 * a new payment on top of a ledger that couldn't be brought up to date,
 * rather than silently proceeding.
 */
export async function reconcileStalePendingAsaas(trx: Transaction<DB>, reservationId: number): Promise<void> {
  const staleRows = await trx
    .selectFrom('payments')
    .select(['id', 'asaas_payment_id'])
    .where('reservation_id', '=', reservationId)
    .where('status', '=', 'pending')
    .where('method', 'in', ['asaas_pix', 'asaas_card'])
    .where('asaas_payment_id', 'is not', null)
    .where('created_at', '<', sql<Date>`current_date`)
    .execute();

  for (const row of staleRows) {
    // Guarded by the `where('asaas_payment_id', 'is not', null)` above, but
    // the column type is still nullable — narrow it for getPayment's string param.
    if (row.asaas_payment_id == null) continue;

    const remote = await getPayment(row.asaas_payment_id);

    if (remote.status === 'PENDING' || remote.status === 'AWAITING_RISK_ANALYSIS') {
      continue; // still genuinely outstanding, keep counting it as pending
    }

    if (RECEIVED_LIKE_STATUSES.has(remote.status)) {
      await processPaymentReceived(trx, {
        asaasPaymentId: row.asaas_payment_id,
        rawEvent: { source: 'reconciliation', asaasStatus: remote.status },
      });
    } else {
      await trx.updateTable('payments').set({ status: 'failed', updated_at: new Date() }).where('id', '=', row.id).execute();
    }
  }
}

/**
 * The authoritative, race-safe check: reconciles stale pending Asaas rows
 * first, then rejects if `amountCents` would push RECEIVED + still-pending
 * Asaas (across ALL kinds, not just the one being charged) past total_cents.
 * MUST run inside the same pg_advisory_xact_lock(reservationId) transaction
 * the caller already holds, right before the charge/insert actually happens
 * — that's what closes the gap a lock-free check can't.
 */
export async function assertNotOverpayingWithPendingAsaas(
  trx: Transaction<DB>,
  reservationId: number,
  amountCents: number,
): Promise<void> {
  await reconcileStalePendingAsaas(trx, reservationId);

  const balance = await trx
    .selectFrom('reservation_balances')
    .select('balance_due_cents')
    .where('reservation_id', '=', reservationId)
    .executeTakeFirst();

  const pendingAsaas = await trx
    .selectFrom('payments')
    .select(sql<string>`COALESCE(SUM(amount_cents), 0)`.as('sum'))
    .where('reservation_id', '=', reservationId)
    .where('status', '=', 'pending')
    .where('method', 'in', ['asaas_pix', 'asaas_card'])
    .executeTakeFirst();

  const balanceDueCents = Number(balance?.balance_due_cents ?? 0);
  const pendingAsaasCents = Number(pendingAsaas?.sum ?? 0);
  const availableCents = balanceDueCents - pendingAsaasCents;

  if (amountCents > availableCents) {
    throw new OverpaymentError(availableCents, amountCents);
  }
}
