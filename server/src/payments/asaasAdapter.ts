/**
 * sdd/asaas-pagarme-migration design (obs #257), decision A1/A5 — the Asaas
 * `PaymentProviderAdapter`. Wraps the existing `asaasClient.ts` calls
 * UNCHANGED (no new request shapes, no behavior change to what's already
 * live in production) and normalizes Asaas's raw status strings into the
 * port's `NormalizedRemoteStatus`, collapsing the two copies of
 * `RECEIVED_LIKE_STATUSES` that exist today in `createOrReusePayment.ts`
 * and `overpaymentGuard.ts` into one place.
 *
 * PR 2 of 6: this adapter is standalone and self-registers at module load
 * (`registerProvider(asaasAdapter)` below), matching the pattern
 * `provider.ts`'s own tests already use with fake adapters. It is NOT yet
 * wired into `createOrReusePayment.ts`/`overpaymentGuard.ts` — those call
 * sites keep calling `asaasClient.ts` directly until task A11 (PR 4)
 * generalizes them to dispatch through `getProvider`/`getActiveProvider`.
 */
import { config } from '../config.js';
import { createCustomer, createPayment, getPayment, getPixQrCode } from '../asaasClient.js';
import {
  registerProvider,
  type CreateChargeInput,
  type CreateChargeResult,
  type NormalizedRemoteStatus,
  type PaymentProviderAdapter,
  type PixQrCode,
} from './provider.js';

const DB_METHOD: Record<'pix' | 'card', 'asaas_pix' | 'asaas_card'> = {
  pix: 'asaas_pix',
  card: 'asaas_card',
};

/** Asaas statuses that mean "money has moved" — same set createOrReusePayment.ts/overpaymentGuard.ts use today. */
const RECEIVED_LIKE_STATUSES = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);
const PENDING_LIKE_STATUSES = new Set(['PENDING', 'AWAITING_RISK_ANALYSIS']);

/**
 * Collapses a raw Asaas status string into the port's normalized set.
 * Anything not explicitly pending/received falls through to 'failed' —
 * fail-safe, mirrors the existing "else mark failed" branches in
 * `createOrReusePayment.ts`/`overpaymentGuard.ts`.
 */
export function normalizeAsaasStatus(status: string): NormalizedRemoteStatus {
  if (PENDING_LIKE_STATUSES.has(status)) return 'pending';
  if (RECEIVED_LIKE_STATUSES.has(status)) return 'received';
  return 'failed';
}

export const asaasAdapter: PaymentProviderAdapter = {
  name: 'asaas',

  dbMethod(method) {
    return DB_METHOD[method];
  },

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const customer = await createCustomer({
      name: input.customer.name,
      cpfCnpj: input.customer.cpfCnpj,
      email: input.customer.email,
      mobilePhone: input.customer.phone,
    });

    const payment = await createPayment({
      customer: customer.id,
      billingType: input.method === 'pix' ? 'PIX' : 'CREDIT_CARD',
      value: input.amountCents / 100,
      dueDate: input.dueDate,
      description: input.description,
      externalReference: input.externalReference,
      callback: {
        successUrl: `${config.frontendBaseUrl}/reservar?code=${input.externalReference}`,
        autoRedirect: true,
      },
    });

    const status = normalizeAsaasStatus(payment.status);

    if (input.method === 'pix') {
      const qr = await getPixQrCode(payment.id);
      return {
        providerPaymentId: payment.id,
        status,
        details: {
          method: 'pix',
          qrCode: { payload: qr.payload, encodedImage: qr.encodedImage, expirationDate: qr.expirationDate },
        },
      };
    }

    // sdd/asaas-pagarme-migration PR 4 (task A11) — invoiceUrl IS returned
    // for Asaas: the tasks artifact's A20 explicitly requires the Asaas
    // checkout redirect to stay byte-identical once call sites dispatch
    // through this adapter. See provider.ts's CreateChargeResult docstring
    // for the full reasoning (this was a real regression found while wiring
    // A11, not a design ambiguity).
    return {
      providerPaymentId: payment.id,
      status,
      details: { method: 'card', invoiceUrl: payment.invoiceUrl },
    };
  },

  async fetchStatus(providerPaymentId: string): Promise<NormalizedRemoteStatus> {
    const payment = await getPayment(providerPaymentId);
    return normalizeAsaasStatus(payment.status);
  },

  async fetchPixDetails(providerPaymentId: string): Promise<PixQrCode> {
    const qr = await getPixQrCode(providerPaymentId);
    return { payload: qr.payload, encodedImage: qr.encodedImage, expirationDate: qr.expirationDate };
  },

  /** Reuse of an existing pending asaas_card row re-fetches its live invoice_url — same remote call the public GET endpoint already made pre-migration. */
  async fetchCardInvoiceUrl(providerPaymentId: string): Promise<string | undefined> {
    const payment = await getPayment(providerPaymentId);
    return payment.invoiceUrl;
  },
};

registerProvider(asaasAdapter);
