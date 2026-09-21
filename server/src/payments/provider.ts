import { config } from '../config.js';

/**
 * sdd/asaas-pagarme-migration design (obs #257), decision A1 — the
 * provider port. Owns ONLY the remote calls (create charge, fetch remote
 * status) and status normalization; all business logic (advisory lock,
 * overpayment guard, reuse rules, confirmation state machine,
 * `reservation_nights` re-check) stays provider-agnostic in the existing
 * call sites and is NOT duplicated here.
 *
 * This file is scaffolding only (PR 1 of 6): the port, its types, and the
 * registry. Concrete adapters (`asaasAdapter.ts` wrapping `asaasClient.ts`,
 * `pagarmeAdapter.ts` wrapping `pagarmeClient.ts`) are PR 2/3 — they call
 * `registerProvider(...)` at module load, the same pattern this file's own
 * test suite uses with fake adapters.
 */

export type ProviderName = 'asaas' | 'pagarme';

/**
 * Every adapter collapses its own raw provider strings (Asaas's
 * PENDING/RECEIVED/CONFIRMED/..., Pagar.me's order/charge status strings)
 * into this one set. Nothing above the adapter layer ever sees a raw
 * provider status string.
 */
export type NormalizedRemoteStatus = 'pending' | 'received' | 'failed';

export interface CreateChargeInput {
  method: 'pix' | 'card';
  /** INTEGER cents — never a float. See server/CLAUDE.md "Convenciones de datos". */
  amountCents: number;
  description: string;
  /** Reservation code — passed through so the provider's dashboard/webhook can be traced back to a reservation. */
  externalReference: string;
  /** YYYY-MM-DD */
  dueDate: string;
  customer: {
    name: string;
    cpfCnpj: string;
    email: string;
    phone: string;
  };
  /**
   * Single-use card token from the frontend's tokenizer. This is the ONLY
   * card-bearing field anywhere in this interface — no raw PAN/CVV/expiry
   * field exists on this type, by design (PCI boundary, see design's
   * "PCI type-level enforcement").
   */
  cardToken?: string;
}

export interface PixQrCode {
  payload: string;
  imageUrl?: string;
  encodedImage?: string;
  expirationDate: string;
}

export type CreateChargeResult = {
  providerPaymentId: string;
  status: NormalizedRemoteStatus;
} & (
  | { details: { method: 'pix'; qrCode: PixQrCode } }
  // `invoiceUrl` is OPTIONAL and provider-specific: Asaas populates it (the
  // existing card checkout redirect — sdd/asaas-pagarme-migration tasks
  // artifact A20 explicitly requires "asaas path stays byte-identical", so
  // this field must keep flowing through for Asaas). Pagar.me never
  // populates it — card confirmation for Pagar.me happens exclusively via
  // the provider's webhook (design's Data Flow / security rule), no
  // redirect. Found during PR 4 (A11): the port originally had NO field
  // here at all, which would have silently dropped Asaas's invoice_url the
  // moment call sites started dispatching through this port — a real
  // regression of the still-live production redirect flow. Fixed here
  // rather than guessed at, since it's directly grounded in A20's explicit
  // "byte-identical" requirement, not an invented business rule.
  | { details: { method: 'card'; invoiceUrl?: string } }
);

export interface PaymentProviderAdapter {
  readonly name: ProviderName;
  /** Maps a local method to this provider's DB method literal, e.g. 'pix' -> 'pagarme_pix'. */
  dbMethod(method: 'pix' | 'card'): string;
  createCharge(input: CreateChargeInput): Promise<CreateChargeResult>;
  fetchStatus(providerPaymentId: string): Promise<NormalizedRemoteStatus>;
  fetchPixDetails?(providerPaymentId: string): Promise<PixQrCode>;
  /**
   * Refetches a live card checkout URL for REUSE of an existing pending
   * charge (e.g. Asaas's invoice_url). Optional — a provider with no
   * redirect-based card flow (Pagar.me) has nothing to re-show here; its
   * pending card charges surface as a `card_awaiting` outcome instead (see
   * createOrReusePayment.ts).
   */
  fetchCardInvoiceUrl?(providerPaymentId: string): Promise<string | undefined>;
}

/**
 * Thrown by `getProvider`/`getActiveProvider` for a name with no
 * registered adapter — deliberately fails loudly (never silently falls
 * back to a different provider) since a silent fallback here would mean
 * routing a real charge to the wrong payment processor.
 */
export class PaymentProviderNotRegisteredError extends Error {
  constructor(name: ProviderName) {
    super(`No payment provider adapter registered for "${name}".`);
  }
}

const registry = new Map<ProviderName, PaymentProviderAdapter>();

export function registerProvider(adapter: PaymentProviderAdapter): void {
  registry.set(adapter.name, adapter);
}

export function getProvider(name: ProviderName): PaymentProviderAdapter {
  const adapter = registry.get(name);
  if (!adapter) {
    throw new PaymentProviderNotRegisteredError(name);
  }
  return adapter;
}

/**
 * Resolves the adapter for a NEW charge only — dispatch for an EXISTING
 * pending row must use `getProvider(row.provider)` instead (per-row
 * dispatch, design decision A2/A3), so in-flight payments under the
 * previous provider keep resolving against that provider during a drain.
 */
export function getActiveProvider(): PaymentProviderAdapter {
  return getProvider(config.payments.provider);
}
