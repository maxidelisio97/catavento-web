/**
 * sdd/asaas-pagarme-migration design (obs #257), decision A1/A7 — the
 * Pagar.me `PaymentProviderAdapter`. Builds/parses `POST /orders` via
 * `pagarmeClient.ts` per the confirmed request shapes (pagarmeClient.ts's
 * own docstring), and normalizes Pagar.me's raw order/charge status
 * strings into the port's `NormalizedRemoteStatus`.
 *
 * PR 3 of 6: this adapter is standalone and self-registers at module load
 * (`registerProvider(pagarmeAdapter)` below), matching the pattern
 * `asaasAdapter.ts` already uses. It is NOT yet wired into
 * `createOrReusePayment.ts`/`overpaymentGuard.ts` — that dispatch is task
 * A11 (PR 4).
 *
 * IMPORTANT security note (design's Data Flow / security rule, unchanged
 * from Asaas): `fetchStatus`/`normalizePagarmeStatus` exist for
 * RECONCILIATION polling only (`overpaymentGuard.ts`'s stale-pending
 * sweep, task A12). They must never be used to confirm a reservation on
 * their own — only a verified `order.paid` webhook delivery does that
 * (`webhooksPagarme.ts`, task A9/A14).
 */
import { createOrder, getOrder } from '../pagarmeClient.js';
import {
  registerProvider,
  type CreateChargeInput,
  type CreateChargeResult,
  type NormalizedRemoteStatus,
  type PaymentProviderAdapter,
  type PixQrCode,
} from './provider.js';

const DB_METHOD: Record<'pix' | 'card', 'pagarme_pix' | 'pagarme_card'> = {
  pix: 'pagarme_pix',
  card: 'pagarme_card',
};

/**
 * Pix expiration window sent to Pagar.me — UNVERIFIED against a live
 * default (Pagar.me may apply its own default if this were omitted; kept
 * explicit here so behavior doesn't depend on an unconfirmed default). 30
 * minutes, matching the guest-facing "reserve while you pay" window this
 * codebase already uses for Asaas pix (dueDate handling in the call
 * sites) — confirm against B1's live probe.
 */
const PIX_EXPIRES_IN_SECONDS = 30 * 60;

/** Pagar.me order/charge statuses that mean "money has moved". */
const RECEIVED_LIKE_STATUSES = new Set(['paid']);
const PENDING_LIKE_STATUSES = new Set(['pending', 'processing']);

/**
 * Collapses a raw Pagar.me order/charge status string into the port's
 * normalized set. Anything not explicitly pending/received falls through
 * to 'failed' — fail-safe, same discipline as `normalizeAsaasStatus`: an
 * unrecognized or future status string must never be silently treated as
 * money received.
 */
export function normalizePagarmeStatus(status: string): NormalizedRemoteStatus {
  if (PENDING_LIKE_STATUSES.has(status)) return 'pending';
  if (RECEIVED_LIKE_STATUSES.has(status)) return 'received';
  return 'failed';
}

function extractPixQrCode(charges: { last_transaction?: { qr_code?: string; qr_code_url?: string; expires_at?: string } }[] | undefined): PixQrCode {
  const lastTransaction = charges?.[0]?.last_transaction;

  if (!lastTransaction?.qr_code) {
    throw new Error('Pagar.me pix order response is missing charges[0].last_transaction.qr_code — see pagarmeClient.ts docstring (UNVERIFIED shape, B1 live probe pending)');
  }

  return {
    payload: lastTransaction.qr_code,
    imageUrl: lastTransaction.qr_code_url,
    expirationDate: lastTransaction.expires_at ?? '',
  };
}

export const pagarmeAdapter: PaymentProviderAdapter = {
  name: 'pagarme',

  dbMethod(method) {
    return DB_METHOD[method];
  },

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const customer = {
      name: input.customer.name,
      email: input.customer.email,
      document: input.customer.cpfCnpj,
      // 11 digits = CPF (individual), 14 = CNPJ (company) — same convention
      // asaasClient's callers already use for cpfCnpj.
      type: (input.customer.cpfCnpj.replace(/\D/g, '').length > 11 ? 'company' : 'individual') as 'individual' | 'company',
    };
    const items = [{ amount: input.amountCents, description: input.description, quantity: 1, code: input.externalReference }];

    if (input.method === 'pix') {
      const order = await createOrder({
        items,
        customer,
        payments: [{ payment_method: 'pix', pix: { expires_in: PIX_EXPIRES_IN_SECONDS } }],
      });

      return {
        providerPaymentId: order.id,
        status: normalizePagarmeStatus(order.status),
        details: { method: 'pix', qrCode: extractPixQrCode(order.charges) },
      };
    }

    if (!input.cardToken) {
      throw new Error('pagarmeAdapter.createCharge: cardToken is required for card charges');
    }

    const order = await createOrder({
      items,
      customer,
      payments: [{ payment_method: 'credit_card', credit_card: { card_token: input.cardToken } }],
    });

    // No `invoice_url`-equivalent field is returned here — card
    // confirmation happens exclusively via the webhook (design's Data
    // Flow / security rule), same as the Asaas adapter.
    return {
      providerPaymentId: order.id,
      status: normalizePagarmeStatus(order.status),
      details: { method: 'card' },
    };
  },

  async fetchStatus(providerPaymentId: string): Promise<NormalizedRemoteStatus> {
    const order = await getOrder(providerPaymentId);
    return normalizePagarmeStatus(order.status);
  },

  async fetchPixDetails(providerPaymentId: string): Promise<PixQrCode> {
    const order = await getOrder(providerPaymentId);
    return extractPixQrCode(order.charges);
  },
};

registerProvider(pagarmeAdapter);
