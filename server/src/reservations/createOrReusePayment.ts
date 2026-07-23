/**
 * Creates the Asaas charge for a reservation's deposit, or reuses the
 * existing one, per SPEC-modulo-4-pago-asaas.md § "Flujo" point 2 and the
 * approved retry rule: if a `pending` payment already exists for the
 * reservation, check its REAL status in Asaas before deciding — reuse it
 * if it's still pending there (same QR/invoice, no duplicate charge),
 * or create a new one if Asaas marked it overdue/failed. Never leaves two
 * `pending` payments for the same reservation.
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

export interface CreateOrReusePaymentInput {
  reservationId: number;
  code: string;
  method: PaymentMethod;
  depositCents: number;
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
export async function createOrReusePayment(db: Kysely<DB>, input: CreateOrReusePaymentInput): Promise<PaymentDetails> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${input.reservationId})`.execute(trx);

    const existing = await trx
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', input.reservationId)
      .where('status', '=', 'pending')
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    if (existing) {
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
        // Align our record so the webhook (or a retry of it) finds a
        // consistent state, then surface this as a conflict — creating a
        // second charge here would risk double-collecting the deposit.
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

    const customer = await createCustomer({
      name: input.guestName,
      cpfCnpj: input.cpfCnpj,
      email: input.guestEmail,
      mobilePhone: input.guestPhone,
    });

    const payment = await createPayment({
      customer: customer.id,
      billingType: input.method === 'pix' ? 'PIX' : 'CREDIT_CARD',
      value: input.depositCents / 100,
      dueDate: input.dueDate,
      description: `Depósito reserva ${input.code} — Pousada Catavento`,
      externalReference: input.code,
      callback: {
        successUrl: `${config.frontendBaseUrl}/reservar?code=${input.code}`,
        autoRedirect: true,
      },
    });

    await trx
      .insertInto('payments')
      .values({
        reservation_id: input.reservationId,
        asaas_payment_id: payment.id,
        method: DB_METHOD[input.method],
        amount_cents: input.depositCents,
        status: 'pending',
      })
      .execute();

    return buildDetails(input.method, payment);
  });
}
