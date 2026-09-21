/**
 * sdd/asaas-pagarme-migration design (obs #257), decision A1/A7 — the
 * Pagar.me `PaymentProviderAdapter`. Builds/parses `POST /orders` via
 * `pagarmeClient.ts` per the confirmed request shapes (see pagarmeClient.ts
 * docstring). This is PR 3 of 6: standalone and self-registering, NOT yet
 * wired into any call site (`createOrReusePayment.ts`) — that's task A11
 * (PR 4).
 *
 * Fixtures are synthetic — no live Pagar.me account exists yet (see task
 * brief). `last_transaction`/status-string shapes are the design's assumed
 * shapes pending the B1 live probe.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createOrder = vi.fn();
const getOrder = vi.fn();

vi.mock('../../pagarmeClient.js', () => ({
  createOrder: (...args: unknown[]) => createOrder(...args),
  getOrder: (...args: unknown[]) => getOrder(...args),
}));

const { pagarmeAdapter, normalizePagarmeStatus } = await import('../pagarmeAdapter.js');
const { getProvider } = await import('../provider.js');

beforeEach(() => {
  createOrder.mockReset();
  getOrder.mockReset();
});

describe('pagarmeAdapter', () => {
  it('registers itself under the "pagarme" name at module load', () => {
    expect(getProvider('pagarme')).toBe(pagarmeAdapter);
    expect(pagarmeAdapter.name).toBe('pagarme');
  });

  describe('dbMethod', () => {
    it('maps pix -> pagarme_pix and card -> pagarme_card', () => {
      expect(pagarmeAdapter.dbMethod('pix')).toBe('pagarme_pix');
      expect(pagarmeAdapter.dbMethod('card')).toBe('pagarme_card');
    });
  });

  describe('normalizePagarmeStatus (table-driven, fail-safe)', () => {
    it.each([
      ['paid', 'received'],
      ['pending', 'pending'],
      ['processing', 'pending'],
      ['failed', 'failed'],
      ['canceled', 'failed'],
      ['refunded', 'failed'],
      ['SOME_UNKNOWN_FUTURE_STATUS', 'failed'],
    ] as const)('%s -> %s', (raw, expected) => {
      expect(normalizePagarmeStatus(raw)).toBe(expected);
    });
  });

  describe('createCharge', () => {
    it('pix: builds the confirmed /orders pix request and returns a normalized pix result', async () => {
      createOrder.mockResolvedValue({
        id: 'or_pix_1',
        status: 'pending',
        charges: [
          {
            id: 'ch_pix_1',
            status: 'pending',
            last_transaction: {
              qr_code: 'copy-paste-pix',
              qr_code_url: 'https://pagarme.test/qr/1',
              expires_at: '2026-09-22T00:00:00Z',
            },
          },
        ],
      });

      const result = await pagarmeAdapter.createCharge({
        method: 'pix',
        amountCents: 10000,
        description: 'Depósito reserva TEST0001 — Pousada Catavento',
        externalReference: 'TEST0001',
        dueDate: '2026-09-01',
        customer: { name: 'Maria Silva', cpfCnpj: '12345678900', email: 'maria@example.com', phone: '11999998888' },
      });

      expect(createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [expect.objectContaining({ amount: 10000, code: 'TEST0001' })],
          customer: expect.objectContaining({ name: 'Maria Silva', email: 'maria@example.com', document: '12345678900' }),
          payments: [{ payment_method: 'pix', pix: { expires_in: expect.any(Number) } }],
        }),
      );
      expect(result).toEqual({
        providerPaymentId: 'or_pix_1',
        status: 'pending',
        details: {
          method: 'pix',
          qrCode: { payload: 'copy-paste-pix', imageUrl: 'https://pagarme.test/qr/1', expirationDate: '2026-09-22T00:00:00Z' },
        },
      });
    });

    it('card: builds the confirmed card_token /orders request and returns card details with no invoiceUrl-equivalent leak', async () => {
      createOrder.mockResolvedValue({
        id: 'or_card_1',
        status: 'paid',
        charges: [{ id: 'ch_card_1', status: 'paid' }],
      });

      const result = await pagarmeAdapter.createCharge({
        method: 'card',
        amountCents: 10000,
        description: 'Depósito reserva TEST0001 — Pousada Catavento',
        externalReference: 'TEST0001',
        dueDate: '2026-09-01',
        customer: { name: 'Maria Silva', cpfCnpj: '12345678900', email: 'maria@example.com', phone: '11999998888' },
        cardToken: 'tok_abc123',
      });

      expect(createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          payments: [{ payment_method: 'credit_card', credit_card: { card_token: 'tok_abc123' } }],
        }),
      );
      expect(result).toEqual({ providerPaymentId: 'or_card_1', status: 'received', details: { method: 'card' } });
    });

    it('card: throws if no cardToken is provided — never silently omits it', async () => {
      await expect(
        pagarmeAdapter.createCharge({
          method: 'card',
          amountCents: 10000,
          description: 'Depósito',
          externalReference: 'TEST0001',
          dueDate: '2026-09-01',
          customer: { name: 'Maria Silva', cpfCnpj: '12345678900', email: 'maria@example.com', phone: '11999998888' },
        }),
      ).rejects.toThrow(/cardToken/i);
      expect(createOrder).not.toHaveBeenCalled();
    });
  });

  describe('fetchStatus', () => {
    it('fetches the order from Pagar.me and normalizes its status', async () => {
      getOrder.mockResolvedValue({ id: 'or_pix_1', status: 'paid' });

      await expect(pagarmeAdapter.fetchStatus('or_pix_1')).resolves.toBe('received');
      expect(getOrder).toHaveBeenCalledWith('or_pix_1');
    });
  });

  describe('fetchPixDetails', () => {
    it('fetches the order and extracts the pix qr code from charges[0].last_transaction', async () => {
      getOrder.mockResolvedValue({
        id: 'or_pix_1',
        status: 'pending',
        charges: [
          {
            id: 'ch_pix_1',
            status: 'pending',
            last_transaction: { qr_code: 'copy-paste', qr_code_url: 'https://pagarme.test/qr/1', expires_at: '2026-09-22T00:00:00Z' },
          },
        ],
      });

      await expect(pagarmeAdapter.fetchPixDetails?.('or_pix_1')).resolves.toEqual({
        payload: 'copy-paste',
        imageUrl: 'https://pagarme.test/qr/1',
        expirationDate: '2026-09-22T00:00:00Z',
      });
    });
  });
});
