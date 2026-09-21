/**
 * sdd/asaas-pagarme-migration design (obs #257), decision A6 — unit tests
 * for `pagarmeClient.ts`. Mocks `global.fetch` (same style as the rest of
 * this codebase's client tests) — no live network call, no real credential
 * needed (per task brief: the Pagar.me account isn't live yet).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PagarmeCardPaymentRequest } from '../pagarmeClient.js';

// Type-level PCI assertion (design's "PCI type-level enforcement"): this
// file fails `tsc --noEmit` if `credit_card` ever gains a raw PAN/CVV/
// expiry field beyond `card_token`. `card_token` is the ONLY entry point
// for card data anywhere in pagarmeClient.ts's types.
type CreditCardKeys = keyof PagarmeCardPaymentRequest['credit_card'];
type OnlyCardTokenField = CreditCardKeys extends 'card_token' ? true : false;
const _assertOnlyCardTokenField: OnlyCardTokenField = true;
void _assertOnlyCardTokenField;

const originalEnv = { ...process.env };

function stubRequiredEnv() {
  process.env.ASAAS_API_KEY = 'asaas-test-key';
  process.env.ASAAS_WEBHOOK_TOKEN = 'asaas-test-webhook-token';
  process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/catavento_db_test';
  process.env.FRONTEND_BASE_URL = 'https://example.test';
}

async function importFreshPagarmeClient() {
  vi.resetModules();
  return import('../pagarmeClient.js');
}

beforeEach(() => {
  process.env = { ...originalEnv };
  stubRequiredEnv();
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

describe('pagarmeClient — PagarmeNotConfiguredError', () => {
  it('throws PagarmeNotConfiguredError at call time when PAGARME_SECRET_KEY is unset, without ever calling fetch', async () => {
    delete process.env.PAGARME_SECRET_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { createOrder, PagarmeNotConfiguredError } = await importFreshPagarmeClient();

    await expect(
      createOrder({
        items: [{ amount: 10000, description: 'Depósito', quantity: 1, code: 'TEST0001' }],
        customer: { name: 'Maria Silva', email: 'maria@example.com', document: '12345678900', type: 'individual' },
        payments: [{ payment_method: 'pix', pix: { expires_in: 3600 } }],
      }),
    ).rejects.toThrow(PagarmeNotConfiguredError);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pagarmeClient — createOrder', () => {
  it('sends HTTP Basic auth (secret key as username, empty password) and the confirmed /orders pix shape', async () => {
    process.env.PAGARME_SECRET_KEY = 'sk_test_123';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'or_pix_1',
        status: 'pending',
        charges: [
          {
            id: 'ch_pix_1',
            status: 'pending',
            last_transaction: { qr_code: 'copy-paste', qr_code_url: 'https://pagarme.test/qr/1', expires_at: '2026-09-22T00:00:00Z' },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { createOrder } = await importFreshPagarmeClient();

    const result = await createOrder({
      items: [{ amount: 10000, description: 'Depósito reserva TEST0001', quantity: 1, code: 'TEST0001' }],
      customer: { name: 'Maria Silva', email: 'maria@example.com', document: '12345678900', type: 'individual' },
      payments: [{ payment_method: 'pix', pix: { expires_in: 3600 } }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://sdx-api.pagar.me/core/v5/orders',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('sk_test_123:').toString('base64')}`,
          'Content-Type': 'application/json',
        }),
      }),
    );
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(sentBody).toEqual({
      items: [{ amount: 10000, description: 'Depósito reserva TEST0001', quantity: 1, code: 'TEST0001' }],
      customer: { name: 'Maria Silva', email: 'maria@example.com', document: '12345678900', type: 'individual' },
      payments: [{ payment_method: 'pix', pix: { expires_in: 3600 } }],
    });
    expect(result.id).toBe('or_pix_1');
    expect(result.charges?.[0].last_transaction?.qr_code).toBe('copy-paste');
  });

  it('sends the confirmed card_token shape for credit_card payments — never a raw PAN', async () => {
    process.env.PAGARME_SECRET_KEY = 'sk_test_123';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'or_card_1', status: 'pending', charges: [{ id: 'ch_card_1', status: 'pending' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { createOrder } = await importFreshPagarmeClient();

    await createOrder({
      items: [{ amount: 10000, description: 'Depósito reserva TEST0001', quantity: 1, code: 'TEST0001' }],
      customer: { name: 'Maria Silva', email: 'maria@example.com', document: '12345678900', type: 'individual' },
      payments: [{ payment_method: 'credit_card', credit_card: { card_token: 'tok_abc123' } }],
    });

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(sentBody.payments).toEqual([{ payment_method: 'credit_card', credit_card: { card_token: 'tok_abc123' } }]);
    expect(JSON.stringify(sentBody)).not.toMatch(/\bnumber\b|\bcvv\b/i);
  });

  it('throws PagarmeApiError with the RESPONSE body on a non-2xx response, and the error message never contains the request body', async () => {
    process.env.PAGARME_SECRET_KEY = 'sk_test_123';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ message: 'invalid card_token' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { createOrder, PagarmeApiError } = await importFreshPagarmeClient();

    let caught: unknown;
    try {
      await createOrder({
        items: [{ amount: 10000, description: 'Depósito', quantity: 1, code: 'TEST0001' }],
        customer: { name: 'Maria Silva', email: 'maria@example.com', document: '12345678900', type: 'individual' },
        payments: [{ payment_method: 'credit_card', credit_card: { card_token: 'tok_secret_value' } }],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PagarmeApiError);
    const apiError = caught as InstanceType<typeof PagarmeApiError>;
    expect(apiError.status).toBe(422);
    expect(apiError.body).toEqual({ message: 'invalid card_token' });
    // The single-use card token must never leak into the error's own message.
    expect(apiError.message).not.toContain('tok_secret_value');
  });

  it('aborts the request via AbortController when it exceeds the timeout', async () => {
    process.env.PAGARME_SECRET_KEY = 'sk_test_123';
    const fetchMock = vi.fn((_url: string, options: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    const { createOrder } = await importFreshPagarmeClient();

    const promise = createOrder({
      items: [{ amount: 10000, description: 'Depósito', quantity: 1, code: 'TEST0001' }],
      customer: { name: 'Maria Silva', email: 'maria@example.com', document: '12345678900', type: 'individual' },
      payments: [{ payment_method: 'pix', pix: { expires_in: 3600 } }],
    });
    const assertion = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(15_001);
    await assertion;

    vi.useRealTimers();
  });
});

describe('pagarmeClient — getOrder', () => {
  it('fetches an order by id with GET and Basic auth', async () => {
    process.env.PAGARME_SECRET_KEY = 'sk_test_123';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'or_pix_1', status: 'paid' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getOrder } = await importFreshPagarmeClient();

    const result = await getOrder('or_pix_1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://sdx-api.pagar.me/core/v5/orders/or_pix_1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.status).toBe('paid');
  });
});
