/**
 * sdd/asaas-pagarme-migration design (obs #257) — config plumbing for
 * Pagar.me. Mirrors config.channex's pattern: credentials are NOT in
 * `required` (no live Pagar.me account until 2026-09-21 — see
 * server/CLAUDE.md), so the server keeps booting without them; only
 * `payments.provider` needs to resolve to a safe default ('asaas') so a
 * missing/unset flag never silently routes new charges to an
 * unconfigured provider.
 *
 * config.ts reads `process.env` once at import time (no hot reload — see
 * design's Rollback section), so each scenario stubs env vars and
 * re-imports the module fresh via `vi.resetModules()`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const REQUIRED_BASE_ENV = {
  ASAAS_API_KEY: 'asaas-test-key',
  ASAAS_WEBHOOK_TOKEN: 'asaas-test-webhook-token',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/catavento_db_test',
  FRONTEND_BASE_URL: 'https://example.test',
};

// Every PAGARME_*/PAYMENTS_PROVIDER var this suite touches, always
// explicitly reset (never via vi.unstubAllEnvs()): this process also runs
// test-support/flushChannexPushes.ts's global `afterEach`, which does its
// own dynamic re-import of config.js's module graph on every test across
// the whole suite. If this file's own cleanup ever reverted these vars to
// "whatever they were before the first stub" (undefined, in a fresh
// worker that hasn't loaded .env yet), that global hook — running after
// this file's afterEach — would reimport config.js with the REQUIRED_BASE_ENV
// vars missing and crash on the "Missing required env var" guard. Explicit
// resets sidestep that ordering hazard entirely.
const ALL_TRACKED_ENV = {
  ...REQUIRED_BASE_ENV,
  PAGARME_SECRET_KEY: '',
  PAGARME_PUBLIC_KEY: '',
  PAGARME_WEBHOOK_SECRET: '',
  PAGARME_ENV: '',
  PAYMENTS_PROVIDER: '',
};

async function importFreshConfig() {
  vi.resetModules();
  return import('../config.js');
}

beforeEach(() => {
  for (const [key, value] of Object.entries(ALL_TRACKED_ENV)) {
    vi.stubEnv(key, value);
  }
});

describe('config.pagarme', () => {
  it('boots without PAGARME_* env vars set (credentials not issued yet)', async () => {
    vi.stubEnv('PAGARME_SECRET_KEY', '');
    vi.stubEnv('PAGARME_PUBLIC_KEY', '');
    vi.stubEnv('PAGARME_WEBHOOK_SECRET', '');

    const { config } = await importFreshConfig();

    expect(config.pagarme.secretKey).toBeUndefined();
    expect(config.pagarme.publicKey).toBeUndefined();
    expect(config.pagarme.webhookSecret).toBeUndefined();
  });

  it('reads PAGARME_* credentials from env when present', async () => {
    vi.stubEnv('PAGARME_SECRET_KEY', 'sk_test_123');
    vi.stubEnv('PAGARME_PUBLIC_KEY', 'pk_test_123');
    vi.stubEnv('PAGARME_WEBHOOK_SECRET', 'whsec_test_123');

    const { config } = await importFreshConfig();

    expect(config.pagarme.secretKey).toBe('sk_test_123');
    expect(config.pagarme.publicKey).toBe('pk_test_123');
    expect(config.pagarme.webhookSecret).toBe('whsec_test_123');
  });

  it('defaults pagarme.baseUrl to the sandbox host unless PAGARME_ENV=production', async () => {
    const { config: sandboxConfig } = await importFreshConfig();
    expect(sandboxConfig.pagarme.baseUrl).toBe('https://sdx-api.pagar.me/core/v5');

    vi.stubEnv('PAGARME_ENV', 'production');
    const { config: prodConfig } = await importFreshConfig();
    expect(prodConfig.pagarme.baseUrl).toBe('https://api.pagar.me/core/v5');
  });
});

describe('config.payments.provider', () => {
  it('defaults to asaas when PAYMENTS_PROVIDER is unset', async () => {
    const { config } = await importFreshConfig();
    expect(config.payments.provider).toBe('asaas');
  });

  it('reads pagarme from PAYMENTS_PROVIDER=pagarme', async () => {
    vi.stubEnv('PAYMENTS_PROVIDER', 'pagarme');
    const { config } = await importFreshConfig();
    expect(config.payments.provider).toBe('pagarme');
  });

  it('falls back to asaas for an unrecognized PAYMENTS_PROVIDER value (fail-safe, never an unknown provider)', async () => {
    vi.stubEnv('PAYMENTS_PROVIDER', 'stripe');
    const { config } = await importFreshConfig();
    expect(config.payments.provider).toBe('asaas');
  });
});
