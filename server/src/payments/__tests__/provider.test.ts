/**
 * sdd/asaas-pagarme-migration design (obs #257), decision A1 — the
 * provider port + registry. This PR (1 of 6) scaffolds ONLY the port:
 * types, `PaymentProviderAdapter` interface, and `getProvider`/
 * `getActiveProvider`/`registerProvider`. The concrete `asaasAdapter.ts`/
 * `pagarmeAdapter.ts` implementations are PR 2/3 — these tests register
 * fake in-test adapters instead of importing real ones.
 *
 * The registry is a module-level Map, so each test re-imports the module
 * fresh (`vi.resetModules()`) to avoid one test's registered adapters
 * leaking into the next.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateChargeInput, CreateChargeResult, NormalizedRemoteStatus, PaymentProviderAdapter } from '../provider.js';

function makeFakeAdapter(name: 'asaas' | 'pagarme'): PaymentProviderAdapter {
  return {
    name,
    dbMethod: (method) => `${name}_${method}`,
    createCharge: async (_input: CreateChargeInput): Promise<CreateChargeResult> => {
      throw new Error('not implemented in fake');
    },
    fetchStatus: async (_providerPaymentId: string): Promise<NormalizedRemoteStatus> => 'pending',
  };
}

async function importFreshProvider() {
  vi.resetModules();
  return import('../provider.js');
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('payments/provider.ts registry', () => {
  it('resolves a registered adapter by name', async () => {
    const { registerProvider, getProvider } = await importFreshProvider();
    const fakeAsaas = makeFakeAdapter('asaas');

    registerProvider(fakeAsaas);

    expect(getProvider('asaas')).toBe(fakeAsaas);
  });

  it('throws a clear error for an unregistered provider name', async () => {
    const { getProvider } = await importFreshProvider();

    expect(() => getProvider('pagarme')).toThrow(/pagarme/i);
  });

  it('dbMethod maps to the provider-prefixed method literal', async () => {
    const { registerProvider, getProvider } = await importFreshProvider();
    registerProvider(makeFakeAdapter('pagarme'));

    expect(getProvider('pagarme').dbMethod('pix')).toBe('pagarme_pix');
    expect(getProvider('pagarme').dbMethod('card')).toBe('pagarme_card');
  });

  describe('getActiveProvider', () => {
    it('resolves the adapter registered for config.payments.provider (default asaas)', async () => {
      const { registerProvider, getActiveProvider } = await importFreshProvider();
      const fakeAsaas = makeFakeAdapter('asaas');
      registerProvider(fakeAsaas);

      expect(getActiveProvider()).toBe(fakeAsaas);
    });

    it('resolves pagarme when PAYMENTS_PROVIDER=pagarme', async () => {
      vi.stubEnv('ASAAS_API_KEY', 'asaas-test-key');
      vi.stubEnv('ASAAS_WEBHOOK_TOKEN', 'asaas-test-webhook-token');
      vi.stubEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/catavento_db_test');
      vi.stubEnv('FRONTEND_BASE_URL', 'https://example.test');
      vi.stubEnv('PAYMENTS_PROVIDER', 'pagarme');

      const { registerProvider, getActiveProvider } = await importFreshProvider();
      const fakePagarme = makeFakeAdapter('pagarme');
      registerProvider(fakePagarme);

      expect(getActiveProvider()).toBe(fakePagarme);
    });

    it('throws (does not silently fall back) when the active provider has no adapter registered', async () => {
      const { getActiveProvider } = await importFreshProvider();

      expect(() => getActiveProvider()).toThrow(/asaas/i);
    });
  });
});
