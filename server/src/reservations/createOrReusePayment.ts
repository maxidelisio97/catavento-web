/**
 * Creates the Asaas charge for a reservation payment, or reuses the existing
 * one, per SPEC-modulo-4-pago-asaas.md § "Flujo" point 2 and the approved
 * retry rule: if a `pending` payment of the SAME kind already exists for the
 * reservation, check its REAL status in Asaas before deciding — reuse it
 * if it's still pending there (same QR/invoice, no duplicate charge),
 * or create a new one if Asaas marked it overdue/failed. Never leaves two
 * `pending` payments of the same kind for the same reservation.
 *
 * Generalized in SPEC-modulo-7-gestion-operativa.md § 5.4 from "always the
 * deposit" (M4) to any `kind` collectable via Asaas (deposit/balance/extra —
 * `refund` is never charged through this path, see § 10 dec.2). `kind` is
 * part of the "is there already a pending charge to reuse" lookup so a stale
 * pending deposit can't be mistaken for (or block) a balance charge attempt.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import {
  createCustomer,
  createPayment,
  getPayment,
  getPixQrCode,
  type AsaasPaymentResponse,
} from '../asaasClient.js';
import { assertNotOverpayingWithPendingAsaas, OverpaymentError } from './overpaymentGuard.js';
import { isPendingPaymentUniqueViolation } from './isPendingPaymentUniqueViolation.js';
import { config } from '../config.js';

export type PaymentMethod = 'pix' | 'card';

// SPEC-modulo-7-gestion-operativa.md § 5.1: `payments.method` was widened
// from ('pix','card') to also cover manually-registered payments
// ('cash','external','pix_manual'). The Asaas-originated values were
// prefixed ('pix' -> 'asaas_pix', 'card' -> 'asaas_card') so the column
// still tells "how it was collected", not just "which Asaas billing type".
// This module's public `PaymentMethod` stays 'pix'|'card' (that's what the
// Asaas API and the public reservation flow speak) — only the DB write uses
// the prefixed form.
const DB_METHOD: Record<PaymentMethod, 'asaas_pix' | 'asaas_card'> = {
  pix: 'asaas_pix',
  card: 'asaas_card',
};

/** `payments.kind` values collectable through Asaas (§ 5.4) — `refund` excluded, see § 10 dec.2. */
export type AsaasPaymentKind = 'deposit' | 'balance' | 'extra';

const KIND_LABEL: Record<AsaasPaymentKind, string> = {
  deposit: 'Depósito',
  balance: 'Saldo',
  extra: 'Extra',
};

export interface CreateOrReuseAsaasPaymentInput {
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
}

export interface PixPaymentDetails {
  method: 'pix';
  paymentId: string;
  qrCode: { encodedImage: string; payload: string; expirationDate: string };
}

export interface CardPaymentDetails {
  method: 'card';
  paymentId: string;
  invoiceUrl: string;
}

export type PaymentDetails = PixPaymentDetails | CardPaymentDetails;

/** Asaas statuses that mean "money has moved" (received or on its way to us). */
const RECEIVED_LIKE_STATUSES = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);

export class PaymentAlreadyReceivedError extends Error {
  constructor() {
    super('Payment for this reservation was already received by Asaas; waiting for webhook confirmation.');
  }
}

async function buildDetails(method: PaymentMethod, payment: AsaasPaymentResponse): Promise<PaymentDetails> {
  if (method === 'pix') {
    const qr = await getPixQrCode(payment.id);
    return {
      method: 'pix',
      paymentId: payment.id,
      qrCode: { encodedImage: qr.encodedImage, payload: qr.payload, expirationDate: qr.expirationDate },
    };
  }
  return { method: 'card', paymentId: payment.id, invoiceUrl: payment.invoiceUrl };
}

/**
 * Serializes concurrent payment-creation attempts for the SAME reservation
 * via a Postgres advisory lock, not a row lock — this needs to stay held
 * across the Asaas network calls below (createCustomer/createPayment), which
 * a `SELECT ... FOR UPDATE` row lock should never do (it would hold a table
 * lock for the duration of an external HTTP round-trip). The advisory lock
 * is scoped to the transaction and released automatically on commit/rollback.
 * Without this, two concurrent requests (double-click, retried fetch) can
 * both pass the "no pending payment" check and both charge the guest.
 */
export async function createOrReuseAsaasPayment(
  db: Kysely<DB>,
  input: CreateOrReuseAsaasPaymentInput,
): Promise<PaymentDetails> {
  return db.transaction().execute(async (trx) => {
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
      if (existing.asaas_payment_id == null) {
        // Defensive: only this function ever inserts a 'pending' payment row,
        // and it always sets asaas_payment_id. A manually-registered payment
        // (§ 5.2 camino B) is always inserted as 'received', never 'pending'.
        // A null here means that invariant broke somewhere else — fail loudly
        // rather than call Asaas with a null payment id.
        throw new Error(`Payment ${existing.id} is 'pending' but has no asaas_payment_id`);
      }

      const remote = await getPayment(existing.asaas_payment_id);

      if (remote.status === 'PENDING' || remote.status === 'AWAITING_RISK_ANALYSIS') {
        if (existing.method === DB_METHOD[input.method]) {
          return buildDetails(input.method, remote);
        }
        // Guest switched method while the old charge is still live in Asaas.
        // We don't cancel it remotely (no cancel endpoint wired up yet) — it
        // just lapses at its own dueDate — but locally it's superseded so a
        // stray late payment on it doesn't get mistaken for an active charge.
        await trx
          .updateTable('payments')
          .set({ status: 'failed', updated_at: new Date() })
          .where('id', '=', existing.id)
          .execute();
      } else if (RECEIVED_LIKE_STATUSES.has(remote.status)) {
        // KNOWN BUG (pre-M7, not fixed here — see server/CLAUDE.md "deuda
        // conocida"): this UPDATE and the throw below run in the same
        // transaction, so Kysely rolls the UPDATE back along with everything
        // else before rethrowing. The local row stays 'pending' even though
        // Asaas already has the money — it does NOT get aligned. Harmless
        // today because the webhook is the real confirmation path, but don't
        // build new logic on top of assuming this persists.
        await trx
          .updateTable('payments')
          .set({ status: 'received', updated_at: new Date() })
          .where('id', '=', existing.id)
          .execute();
        throw new PaymentAlreadyReceivedError();
      } else {
        // Overdue/failed/etc in Asaas: mark it failed locally and fall through to create a new one.
        await trx
          .updateTable('payments')
          .set({ status: 'failed', updated_at: new Date() })
          .where('id', '=', existing.id)
          .execute();
      }
    }

    // Re-check under the SAME lock, all kinds summed, right before creating
    // the Asaas charge — closes the gap the outer per-request check in
    // registerPayment can't: two charges of DIFFERENT kind (e.g. deposit +
    // balance), each individually within balance_due_cents while both are
    // still `pending`, would otherwise both get created and both get paid.
    // No thread race needed for the vulnerability, but this lock closes the
    // truly-concurrent variant too (see overpaymentGuard.ts).
    await assertNotOverpayingWithPendingAsaas(trx, input.reservationId, input.amountCents);

    const customer = await createCustomer({
      name: input.guestName,
      cpfCnpj: input.cpfCnpj,
      email: input.guestEmail,
      mobilePhone: input.guestPhone,
    });

    const payment = await createPayment({
      customer: customer.id,
      billingType: input.method === 'pix' ? 'PIX' : 'CREDIT_CARD',
      value: input.amountCents / 100,
      dueDate: input.dueDate,
      description: `${KIND_LABEL[input.kind]} reserva ${input.code} — Pousada Catavento`,
      externalReference: input.code,
      callback: {
        successUrl: `${config.frontendBaseUrl}/reservar?code=${input.code}`,
        autoRedirect: true,
      },
    });

    try {
      await trx
        .insertInto('payments')
        .values({
          reservation_id: input.reservationId,
          asaas_payment_id: payment.id,
          kind: input.kind,
          method: DB_METHOD[input.method],
          amount_cents: input.amountCents,
          status: 'pending',
        })
        .execute();
    } catch (err) {
      // Risk-review finding: idx_payments_one_pending_per_reservation isn't
      // kind-scoped, so a second pending charge of a DIFFERENT kind can pass
      // assertNotOverpayingWithPendingAsaas above (the combined amount still
      // fits under balance_due_cents) and still collide with this index —
      // the money guard and the DB constraint protect overlapping but not
      // identical things. Without this, that collision surfaced as a raw
      // unhandled 500. balanceDueCents is unknown at this point (the index
      // doesn't expose it) — 0 signals "no room left for a new pending
      // charge", which is what the constraint is actually saying.
      if (isPendingPaymentUniqueViolation(err)) {
        throw new OverpaymentError(0, input.amountCents);
      }
      throw err;
    }

    return buildDetails(input.method, payment);
  });
}
