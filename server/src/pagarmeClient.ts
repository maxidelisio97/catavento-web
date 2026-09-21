/**
 * sdd/asaas-pagarme-migration design (obs #257), decision A6 — typed request
 * wrapper for Pagar.me's core v5 API, mirroring `asaasClient.ts`'s shape: a
 * thin fetch wrapper, a custom error class carrying only the RESPONSE body
 * (never the request body — a card order's request body carries
 * `card_token`, a single-use secret with the same PCI-adjacent sensitivity
 * as a raw PAN, see design's "PCI type-level enforcement"), and integer
 * cents throughout.
 *
 * Confirmed live against docs.pagar.me on 2026-09-20 (task brief for PR 3):
 * - Auth: HTTP Basic, secret key as username, empty password
 *   (`Authorization: Basic base64(sk_KEY:)`).
 * - Endpoint: POST /orders (NOT /paymentlinks — locked decision D1).
 * - Pix: `payments: [{ payment_method: 'pix', pix: { expires_in } }]`.
 * - Card: `payments: [{ payment_method: 'credit_card', credit_card: { card_token } }]`
 *   — never a raw PAN/CVV shape; `card_token` is the only entry point.
 * - Pix response: `last_transaction.qr_code` (copia-e-cola) and
 *   `.qr_code_url` (QR image), assumed to live on the order's `charges[0]`
 *   (Pagar.me v5 orders contain charges) — UNVERIFIED against a real
 *   response, see below.
 *
 * UNVERIFIED (no live Pagar.me account yet — server/CLAUDE.md, design's
 * Open Questions, tasks artifact's Group B): whether `last_transaction`
 * really nests under `charges[0]` as assumed here, and any additional
 * `customer`/`items` fields Pagar.me's API may require server-side (e.g.
 * address) beyond what's used here. The B1 live shape probe (tasks
 * artifact, blocked until 2026-09-21) is the follow-up that confirms or
 * corrects this — isolated to this one client file so that correction is a
 * small, contained diff, not a design rewrite.
 *
 * Channex lesson (server/CLAUDE.md "Módulo 12C" — "The Channex client now
 * has a request timeout — it never had one"): every new client gets a
 * request timeout from day one. `asaasClient.ts` never got one; this one
 * doesn't repeat that gap.
 */
import { config } from './config.js';

const REQUEST_TIMEOUT_MS = 15_000;

export class PagarmeApiError extends Error {
  status: number;
  /** Response body ONLY — never the request body (may carry `card_token`). */
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`Pagar.me API error (${status}): ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Thrown at CALL time, not at server boot — `PAGARME_SECRET_KEY` is
 * deliberately not in `config.ts`'s `required` list (the account activates
 * 2026-09-21; the server, dev environment, and test suite must keep working
 * before that credential exists). See `config.ts`'s `pagarme` block.
 */
export class PagarmeNotConfiguredError extends Error {
  constructor() {
    super('Pagar.me is not configured: PAGARME_SECRET_KEY is not set.');
  }
}

interface PagarmeRequestOptions {
  method?: string;
  body?: unknown;
}

async function pagarmeRequest<T>(path: string, { method = 'GET', body }: PagarmeRequestOptions = {}): Promise<T> {
  if (!config.pagarme.secretKey) {
    throw new PagarmeNotConfiguredError();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.pagarme.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // HTTP Basic, secret key as username, empty password — confirmed
        // live against docs.pagar.me on 2026-09-20.
        Authorization: `Basic ${Buffer.from(`${config.pagarme.secretKey}:`).toString('base64')}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new PagarmeApiError(response.status, data);
    }

    return data as T;
  } finally {
    clearTimeout(timeout);
  }
}

export interface PagarmeOrderItem {
  /** INTEGER cents — never a float. See server/CLAUDE.md "Convenciones de datos". */
  amount: number;
  description: string;
  quantity: number;
  code: string;
}

export interface PagarmeCustomer {
  name: string;
  email: string;
  document: string;
  type: 'individual' | 'company';
}

export interface PagarmePixPaymentRequest {
  payment_method: 'pix';
  pix: { expires_in: number };
}

/**
 * `card_token` is the ONLY card-bearing field anywhere in this file's
 * types — no raw PAN/CVV/expiry field exists on this or any other exported
 * type (PCI boundary, design's "PCI type-level enforcement"). Tokenization
 * happens entirely on the frontend via `tokenizecard.js` (PR 5); this
 * client only ever forwards the resulting token.
 */
export interface PagarmeCardPaymentRequest {
  payment_method: 'credit_card';
  credit_card: { card_token: string };
}

export interface PagarmeCreateOrderRequest {
  items: PagarmeOrderItem[];
  customer: PagarmeCustomer;
  payments: [PagarmePixPaymentRequest] | [PagarmeCardPaymentRequest];
}

export interface PagarmeLastTransaction {
  qr_code?: string;
  qr_code_url?: string;
  expires_at?: string;
  [key: string]: unknown;
}

export interface PagarmeCharge {
  id: string;
  status: string;
  last_transaction?: PagarmeLastTransaction;
  [key: string]: unknown;
}

export interface PagarmeOrderResponse {
  id: string;
  status: string;
  charges?: PagarmeCharge[];
  [key: string]: unknown;
}

export function createOrder(request: PagarmeCreateOrderRequest): Promise<PagarmeOrderResponse> {
  return pagarmeRequest('/orders', { method: 'POST', body: request });
}

export function getOrder(orderId: string): Promise<PagarmeOrderResponse> {
  return pagarmeRequest(`/orders/${orderId}`);
}
