/**
 * Creates a payment-provider charge for a reservation payment, or reuses the
 * existing one, per SPEC-modulo-4-pago-asaas.md § "Flujo" point 2 and the
 * approved retry rule: if a `pending` payment of the SAME kind already
 * exists for the reservation, check its REAL status with the provider
 * before deciding — reuse it if it's still pending there (same QR/invoice,
 * no duplicate charge), or create a new one if the provider marked it
 * overdue/failed. Never leaves two `pending` payments of the same kind for
 * the same reservation.
 *
 * Generalized in SPEC-modulo-7-gestion-operativa.md § 5.4 from "always the
 * deposit" (M4) to any `kind` collectable via a provider (deposit/balance/
 * extra — `refund` is never charged through this path, see § 10 dec.2).
 * `kind` is part of the "is there already a pending charge to reuse" lookup
 * so a stale pending deposit can't be mistaken for (or block) a balance
 * charge attempt.
 *
 * sdd/asaas-pagarme-migration design (obs #257), decision A6/A11 — renamed
 * from `createOrReuseAsaasPayment` and generalized to dispatch through the
 * `PaymentProviderAdapter` port (provider.ts) instead of calling
 * `asaasClient.ts` directly. Dispatch rule (design's Call-site integration
 * table, non-negotiable): `getActiveProvider()` (the `config.payments.provider`
 * flag) for a NEW charge; `getProvider(existing.provider)` — per EXISTING
 * row, never the active flag — when re-checking a still-pending row. This
 * is what keeps an in-flight Asaas payment resolving against Asaas during a
 * provider drain, even after the flag flips to Pagar.me.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { assertNotOverpayingWithPendingProvider, OverpaymentError } from './overpaymentGuard.js';
import { isPendingPaymentUniqueViolation } from './isPendingPaymentUniqueViolation.js';
import { schedulePushAvailabilityForReservation } from '../channex/pushAvailability.js';
import {
  getActiveProvider,
  getProvider,
  type CreateChargeResult,
  type PaymentProviderAdapter,
  type PixQrCode,
  type ProviderName,
} from '../payments/provider.js';

export type PaymentMethod = 'pix' | 'card';

/** `payments.kind` values collectable through a provider (§ 5.4) — `refund` excluded, see § 10 dec.2. */
export type AsaasPaymentKind = 'deposit' | 'balance' | 'extra';

const KIND_LABEL: Record<AsaasPaymentKind, string> = {
  deposit: 'Depósito',
  balance: 'Saldo',
  extra: 'Extra',
};

export interface CreateOrReuseProviderPaymentInput {
  reservationId: number;
  code: string;
  kind: AsaasPaymentKind;
  method: PaymentMethod;
  amountCents: number;
  dueDate: string; // YYYY-MM-DD, calendar date of expires_at (see spec decision #4)
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  cpfCnpj: string;
  /**
   * Single-use card token from the frontend's tokenizer (Pagar.me's
   * `tokenizecard.js`). Ignored for `method: 'pix'` and for Asaas charges
   * (Asaas's card flow doesn't use a token). See provider.ts's PCI note —
   * this is the ONLY card-bearing field in this input.
   */
  cardToken?: string;
}

/** @deprecated Use {@link CreateOrReuseProviderPaymentInput} — kept as an alias during the migration, both names are structurally identical. */
export type CreateOrReuseAsaasPaymentInput = CreateOrReuseProviderPaymentInput;

export interface PixPaymentDetails {
  method: 'pix';
  provider: ProviderName;
  paymentId: string;
  qrCode: PixQrCode;
}

export interface CardPaymentDetails {
  method: 'card';
  provider: ProviderName;
  paymentId: string;
  /** Only Asaas has a redirect checkout — Pagar.me confirms exclusively via webhook, see provider.ts's CreateChargeResult docstring. */
  invoiceUrl?: string;
}

/**
 * sdd/asaas-pagarme-migration design's Call-site integration table, "Card
 * reuse" note: a pending `pagarme_card` row has nothing to re-show (no
 * redirect, no live invoice) — this outcome tells the caller to keep the
 * guest waiting for the webhook rather than creating a second order.
 */
export interface CardAwaitingDetails {
  method: 'card_awaiting';
  provider: ProviderName;
  paymentId: string;
}

export type PaymentDetails = PixPaymentDetails | CardPaymentDetails | CardAwaitingDetails;

export class PaymentAlreadyReceivedError extends Error {
  constructor() {
    super('Payment for this reservation was already received by the payment provider; waiting for webhook confirmation.');
  }
}

function chargeResultToDetails(provider: ProviderName, result: CreateChargeResult): PaymentDetails {
  if (result.details.method === 'pix') {
    return { method: 'pix', provider, paymentId: result.providerPaymentId, qrCode: result.details.qrCode };
  }
  return { method: 'card', provider, paymentId: result.providerPaymentId, invoiceUrl: result.details.invoiceUrl };
}

async function reusePixDetails(
  adapter: PaymentProviderAdapter,
  provider: ProviderName,
  providerPaymentId: string,
): Promise<PixPaymentDetails> {
  // Both adapters implement fetchPixDetails (it's not optional in practice
  // for either concrete provider) — the `!` mirrors the port's own
  // optionality contract (an adapter with no pix support at all would need
  // its own guard, neither current adapter is that).
  const qrCode = await adapter.fetchPixDetails!(providerPaymentId);
  return { method: 'pix', provider, paymentId: providerPaymentId, qrCode };
}

async function reuseCardDetails(
  adapter: PaymentProviderAdapter,
  provider: ProviderName,
  providerPaymentId: string,
): Promise<CardPaymentDetails | CardAwaitingDetails> {
  if (adapter.fetchCardInvoiceUrl) {
    const invoiceUrl = await adapter.fetchCardInvoiceUrl(providerPaymentId);
    return { method: 'card', provider, paymentId: providerPaymentId, invoiceUrl };
  }
  return { method: 'card_awaiting', provider, paymentId: providerPaymentId };
}

/**
 * Serializes concurrent payment-creation attempts for the SAME reservation
 * via a Postgres advisory lock, not a row lock — this needs to stay held
 * across the provider's network calls below (createCharge/fetchStatus/
 * fetch*Details), which a `SELECT ... FOR UPDATE` row lock should never do
 * (it would hold a table lock for the duration of an external HTTP
 * round-trip). The advisory lock is scoped to the transaction and released
 * automatically on commit/rollback. Without this, two concurrent requests
 * (double-click, retried fetch) can both pass the "no pending payment"
 * check and both charge the guest.
 */
export async function createOrReuseProviderPayment(
  db: Kysely<DB>,
  input: CreateOrReuseProviderPaymentInput,
): Promise<PaymentDetails> {
  // sdd/asaas-pagarme-migration PR 2 (obs #257/#258, task A3) — rollback-bug
  // fix, preserved verbatim through the PR 4 generalization (A11's task
  // note explicitly calls this out: confirm the fix's deferred-throw
  // pattern survives the rename, not just re-verify the old behavior). The
  // "provider already has the money" branch below now COMMITS the "mark
  // received" UPDATE with the rest of the transaction: instead of throwing
  // PaymentAlreadyReceivedError from inside the trx callback (which made
  // Kysely roll that UPDATE back along with everything else), it sets this
  // flag and returns `null` from the callback so the transaction commits
  // normally, then the error is thrown AFTER commit, below.
  let alreadyReceivedByProvider = false;

  const result = await db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${input.reservationId})`.execute(trx);

    const existing = await trx
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', input.reservationId)
      .where('kind', '=', input.kind)
      .where('status', '=', 'pending')
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    if (existing) {
      if (existing.provider == null || existing.provider_payment_id == null) {
        // Defensive: only this function ever inserts a 'pending' payment row,
        // and it always sets provider/provider_payment_id (migration
        // backfills both for legacy asaas_payment_id-only rows). A
        // manually-registered payment (§ 5.2 camino B) is always inserted
        // as 'received', never 'pending'. A null here means that invariant
        // broke somewhere else — fail loudly rather than dispatch to an
        // adapter with a null provider/id.
        throw new Error(`Payment ${existing.id} is 'pending' but has no provider/provider_payment_id`);
      }

      const providerName = existing.provider as ProviderName;
      const providerPaymentId = existing.provider_payment_id;
      // Per-row dispatch (design A2/A3): the EXISTING row's own provider,
      // never the active flag — this is what keeps an in-flight payment
      // resolving against the provider it was actually created under.
      const adapter = getProvider(providerName);
      const remoteStatus = await adapter.fetchStatus(providerPaymentId);

      if (remoteStatus === 'pending') {
        if (existing.method === adapter.dbMethod(input.method)) {
          return input.method === 'pix'
            ? reusePixDetails(adapter, providerName, providerPaymentId)
            : reuseCardDetails(adapter, providerName, providerPaymentId);
        }
        // Guest switched method while the old charge is still live with the
        // provider. We don't cancel it remotely (no cancel endpoint wired
        // up yet) — it just lapses at its own dueDate — but locally it's
        // superseded so a stray late payment on it doesn't get mistaken
        // for an active charge.
        await trx
          .updateTable('payments')
          .set({ status: 'failed', updated_at: new Date() })
          .where('id', '=', existing.id)
          .execute();
      } else if (remoteStatus === 'received') {
        // FIXED (was: KNOWN BUG, pre-M7 — see server/CLAUDE.md "Deuda
        // conocida" / sdd/asaas-pagarme-migration task A3): this UPDATE must
        // survive even though the caller still needs PaymentAlreadyReceivedError
        // to reach it. Throwing here would make Kysely roll this UPDATE back
        // with everything else in the transaction. Instead: let the UPDATE
        // commit as part of this transaction, record that the caller must be
        // told via `alreadyReceivedByProvider`, and return early (skipping the
        // overpayment re-check / new-charge creation below) — the actual
        // throw happens AFTER the transaction commits, outside this callback.
        await trx
          .updateTable('payments')
          .set({ status: 'received', received_at: new Date(), updated_at: new Date() })
          .where('id', '=', existing.id)
          .execute();
        alreadyReceivedByProvider = true;
        return null;
      } else {
        // Overdue/failed/etc with the provider: mark it failed locally and fall through to create a new one.
        await trx
          .updateTable('payments')
          .set({ status: 'failed', updated_at: new Date() })
          .where('id', '=', existing.id)
          .execute();
      }
    }

    // Re-check under the SAME lock, all kinds summed, right before creating
    // the charge — closes the gap the outer per-request check in
    // registerPayment can't: two charges of DIFFERENT kind (e.g. deposit +
    // balance), each individually within balance_due_cents while both are
    // still `pending`, would otherwise both get created and both get paid.
    // No thread race needed for the vulnerability, but this lock closes the
    // truly-concurrent variant too (see overpaymentGuard.ts).
    await assertNotOverpayingWithPendingProvider(trx, input.reservationId, input.amountCents);

    // NEW charge: dispatch by the active flag, never by the existing row's
    // provider (there is none — this is the create path).
    const activeAdapter = getActiveProvider();

    const chargeResult = await activeAdapter.createCharge({
      method: input.method,
      amountCents: input.amountCents,
      description: `${KIND_LABEL[input.kind]} reserva ${input.code} — Pousada Catavento`,
      externalReference: input.code,
      dueDate: input.dueDate,
      customer: {
        name: input.guestName,
        cpfCnpj: input.cpfCnpj,
        email: input.guestEmail,
        phone: input.guestPhone,
      },
      cardToken: input.cardToken,
    });

    try {
      await trx
        .insertInto('payments')
        .values({
          reservation_id: input.reservationId,
          provider: activeAdapter.name,
          provider_payment_id: chargeResult.providerPaymentId,
          // Dual-write while provider='asaas' (design's migration note) —
          // asaas_payment_id stays the join key for any code that hasn't
          // migrated to provider_payment_id yet, and lets a rollback to
          // PAYMENTS_PROVIDER=asaas need no data migration.
          asaas_payment_id: activeAdapter.name === 'asaas' ? chargeResult.providerPaymentId : null,
          kind: input.kind,
          method: activeAdapter.dbMethod(input.method),
          amount_cents: input.amountCents,
          status: 'pending',
        })
        .execute();
    } catch (err) {
      // Risk-review finding: idx_payments_one_pending_per_reservation isn't
      // kind-scoped, so a second pending charge of a DIFFERENT kind can pass
      // assertNotOverpayingWithPendingProvider above (the combined amount
      // still fits under balance_due_cents) and still collide with this
      // index — the money guard and the DB constraint protect overlapping
      // but not identical things. Without this, that collision surfaced as
      // a raw unhandled 500. balanceDueCents is unknown at this point (the
      // index doesn't expose it) — 0 signals "no room left for a new
      // pending charge", which is what the constraint is actually saying.
      if (isPendingPaymentUniqueViolation(err)) {
        throw new OverpaymentError(0, input.amountCents);
      }
      throw err;
    }

    return chargeResultToDetails(activeAdapter.name, chargeResult);
  });

  if (alreadyReceivedByProvider) {
    // Thrown here, AFTER the transaction above committed — see the comment
    // on `alreadyReceivedByProvider`'s declaration. Deliberately does NOT
    // call schedulePushAvailabilityForReservation below: nothing about
    // availability/nights changed on this path, only a payment's status,
    // matching this function's pre-fix behavior on every other exit.
    throw new PaymentAlreadyReceivedError();
  }

  // SPEC-modulo-12C § 3.2 (gap found in fresh-context risk review, not one
  // of the spec's 6 named triggers): `assertNotOverpayingWithPendingProvider`
  // above can silently confirm this reservation via
  // `reconcileStalePendingProviderPayments` -> `processPaymentReceived(trx, ...)`
  // (reentrant, so it does NOT push itself — the outer transaction owner
  // is responsible, same convention as every other reentrant call in this
  // module). That reentrant confirm and this function's own writes share
  // ONE transaction, so pushing unconditionally after it commits is always
  // safe (a no-op re-sync when nothing actually changed, correct when it did).
  schedulePushAvailabilityForReservation(db, [input.reservationId]);
  // `result` is only null on the alreadyReceivedByProvider path, which
  // already returned via the throw above.
  return result as PaymentDetails;
}

/** @deprecated Use {@link createOrReuseProviderPayment} — kept as an alias during the migration so any straggler import keeps compiling; all in-repo call sites have been updated. */
export const createOrReuseAsaasPayment = createOrReuseProviderPayment;
