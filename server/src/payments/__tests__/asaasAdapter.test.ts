/**
 * sdd/asaas-pagarme-migration design (obs #257), decision A1/A5 — the Asaas
 * adapter. Wraps `asaasClient.ts` UNCHANGED (no new request shapes) and
 * normalizes Asaas's raw status strings into the port's
 * `NormalizedRemoteStatus`. This is PR 2 of 6: only `asaasAdapter.ts` is
 * wired up here — call sites (`createOrReusePayment.ts`) still talk to
 * `asaasClient.ts` directly; dispatching them through this adapter is task
 * A11 (PR 4).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createCustomer = vi.fn();
const createPayment = vi.fn();
const getPayment = vi.fn();
const getPixQrCode = vi.fn();

vi.mock('../../asaasClient.js', () => ({
  createCustomer: (...args: unknown[]) => createCustomer(...args),
  createPayment: (...args: unknown[]) => createPayment(...args),
  getPayment: (...args: unknown[]) => getPayment(...args),
  getPixQrCode: (...args: unknown[]) => getPixQrCode(...args),
}));

const { asaasAdapter, normalizeAsaasStatus } = await import('../asaasAdapter.js');
const { getProvider } = await import('../provider.js');

beforeEach(() => {
  createCustomer.mockReset();
  createPayment.mockReset();
  getPayment.mockReset();
  getPixQrCode.mockReset();
});

describe('asaasAdapter', () => {
  it('registers itself under the "asaas" name at module load', () => {
    expect(getProvider('asaas')).toBe(asaasAdapter);
    expect(asaasAdapter.name).toBe('asaas');
  });

  describe('dbMethod', () => {
    it('maps pix -> asaas_pix and card -> asaas_card', () => {
      expect(asaasAdapter.dbMethod('pix')).toBe('asaas_pix');
      expect(asaasAdapter.dbMethod('card')).toBe('asaas_card');
    });
  });

  describe('normalizeAsaasStatus (table-driven)', () => {
    it.each([
      ['PENDING', 'pending'],
      ['AWAITING_RISK_ANALYSIS', 'pending'],
      ['RECEIVED', 'received'],
      ['CONFIRMED', 'received'],
      ['RECEIVED_IN_CASH', 'received'],
      ['OVERDUE', 'failed'],
      ['REFUNDED', 'failed'],
      ['SOME_UNKNOWN_FUTURE_STATUS', 'failed'],
    ] as const)('%s -> %s', (raw, expected) => {
      expect(normalizeAsaasStatus(raw)).toBe(expected);
    });
  });

  describe('createCharge', () => {
    it('pix: creates a customer + PIX payment and returns a normalized pix result', async () => {
      createCustomer.mockResolvedValue({ id: 'cus_1' });
      createPayment.mockResolvedValue({ id: 'pay_1', status: 'PENDING', invoiceUrl: 'https://asaas.test/inv/1' });
      getPixQrCode.mockResolvedValue({
        encodedImage: 'img',
        payload: 'copy-paste',
        expirationDate: '2026-09-01T00:00:00Z',
      });

      const result = await asaasAdapter.createCharge({
        method: 'pix',
        amountCents: 10000,
        description: 'Depósito reserva TEST0001 — Pousada Catavento',
        externalReference: 'TEST0001',
        dueDate: '2026-09-01',
        customer: { name: 'Maria Silva', cpfCnpj: '12345678900', email: 'maria@example.com', phone: '11999998888' },
      });

      expect(createCustomer).toHaveBeenCalledWith({
        name: 'Maria Silva',
        cpfCnpj: '12345678900',
        email: 'maria@example.com',
        mobilePhone: '11999998888',
      });
      expect(createPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_1',
          billingType: 'PIX',
          value: 100, // amountCents / 100
          dueDate: '2026-09-01',
          description: 'Depósito reserva TEST0001 — Pousada Catavento',
          externalReference: 'TEST0001',
        }),
      );
      expect(getPixQrCode).toHaveBeenCalledWith('pay_1');
      expect(result).toEqual({
        providerPaymentId: 'pay_1',
        status: 'pending',
        details: {
          method: 'pix',
          qrCode: { payload: 'copy-paste', encodedImage: 'img', expirationDate: '2026-09-01T00:00:00Z' },
        },
      });
    });

    it('card: creates a customer + CREDIT_CARD payment, returns card details with no invoiceUrl leak, never calls getPixQrCode', async () => {
      createCustomer.mockResolvedValue({ id: 'cus_1' });
      createPayment.mockResolvedValue({ id: 'pay_2', status: 'RECEIVED', invoiceUrl: 'https://asaas.test/inv/2' });

      const result = await asaasAdapter.createCharge({
        method: 'card',
        amountCents: 10000,
        description: 'Depósito reserva TEST0001 — Pousada Catavento',
        externalReference: 'TEST0001',
        dueDate: '2026-09-01',
        customer: { name: 'Maria Silva', cpfCnpj: '12345678900', email: 'maria@example.com', phone: '11999998888' },
      });

      expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ billingType: 'CREDIT_CARD' }));
      expect(getPixQrCode).not.toHaveBeenCalled();
      expect(result).toEqual({
        providerPaymentId: 'pay_2',
        status: 'received',
        details: { method: 'card' },
      });
    });
  });

  describe('fetchStatus', () => {
    it('fetches the payment from Asaas and normalizes its status', async () => {
      getPayment.mockResolvedValue({ id: 'pay_3', status: 'CONFIRMED', invoiceUrl: 'https://asaas.test/inv/3' });

      await expect(asaasAdapter.fetchStatus('pay_3')).resolves.toBe('received');
      expect(getPayment).toHaveBeenCalledWith('pay_3');
    });
  });

  describe('fetchPixDetails', () => {
    it('fetches the pix QR code by provider payment id', async () => {
      getPixQrCode.mockResolvedValue({ encodedImage: 'img', payload: 'copy', expirationDate: '2026-09-01T00:00:00Z' });

      await expect(asaasAdapter.fetchPixDetails?.('pay_4')).resolves.toEqual({
        payload: 'copy',
        encodedImage: 'img',
        expirationDate: '2026-09-01T00:00:00Z',
      });
      expect(getPixQrCode).toHaveBeenCalledWith('pay_4');
    });
  });
});
