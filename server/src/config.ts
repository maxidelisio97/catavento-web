import 'dotenv/config';

const required = ['ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN', 'DATABASE_URL', 'FRONTEND_BASE_URL'] as const;

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`);
  }
}

type AsaasEnv = 'sandbox' | 'production';

const env: AsaasEnv = process.env.ASAAS_ENV === 'production' ? 'production' : 'sandbox';

type ChannexEnv = 'staging' | 'production';

const channexEnv: ChannexEnv = process.env.CHANNEX_ENV === 'production' ? 'production' : 'staging';

type PagarmeEnv = 'sandbox' | 'production';

const pagarmeEnv: PagarmeEnv = process.env.PAGARME_ENV === 'production' ? 'production' : 'sandbox';

type PaymentsProvider = 'asaas' | 'pagarme';

// Fail-safe default: an unset or unrecognized PAYMENTS_PROVIDER value must
// never silently route new charges to an unconfigured/unknown provider —
// 'asaas' is the only provider with a live, credentialed account today
// (sdd/asaas-pagarme-migration design, obs #257, "Feature-flagged hard
// cutover").
const paymentsProvider: PaymentsProvider = process.env.PAYMENTS_PROVIDER === 'pagarme' ? 'pagarme' : 'asaas';

export const config = {
  port: Number(process.env.PORT) || 3001,
  databaseUrl: process.env.DATABASE_URL as string,
  // Base URL of the public frontend, used to build the Asaas `callback.successUrl`
  // that redirects the guest back to /reservar after paying with card/PIX.
  // Required (not defaulted) — a silent localhost fallback in production
  // would send paying guests to a dead redirect after a real charge.
  frontendBaseUrl: process.env.FRONTEND_BASE_URL as string,
  isProduction: process.env.NODE_ENV === 'production',
  // SPEC-modulo-6-panel-base.md § "6B.2 Sesiones": Domain of the session
  // cookie in production is painel.cataventotaiba.com. Left undefined in
  // dev/test on purpose — the cookie then defaults to the request's own
  // host, which is what makes login work against localhost.
  panelCookieDomain: process.env.PANEL_COOKIE_DOMAIN,
  asaas: {
    env,
    apiKey: process.env.ASAAS_API_KEY as string,
    webhookToken: process.env.ASAAS_WEBHOOK_TOKEN as string,
    baseUrl:
      env === 'production'
        ? 'https://api.asaas.com'
        : 'https://api-sandbox.asaas.com',
  },
  channex: {
    env: channexEnv,
    // Deliberately NOT in `required` above (unlike ASAAS_API_KEY): M12 is
    // brand new and Maxi loads this key by hand once 12A's test-connection
    // is ready to try against the real staging property (SPEC-modulo-12A
    // § 4) — the server, dev environment, and test suite must keep working
    // before that happens. channexClient.ts throws a clear
    // ChannexNotConfiguredError at call time instead of failing at boot.
    apiKey: process.env.CHANNEX_API_KEY,
    baseUrl:
      channexEnv === 'production'
        ? 'https://app.channex.io/api/v1'
        : 'https://staging.channex.io/api/v1',
    // SPEC-modulo-12B-reservas-entrantes.md § 3.3: Channex doesn't sign
    // webhooks with HMAC — this is a custom header value WE choose when
    // configuring the webhook on Channex's side, verified with the same
    // constant-time comparison as Asaas's token, but never the SAME secret
    // (§ 7: "el secreto de Channex no se confunda ni se filtre junto al de
    // Asaas"). Deliberately not in `required` above, same reasoning as
    // CHANNEX_API_KEY: M12 is still being wired up by hand.
    webhookSecret: process.env.CHANNEX_WEBHOOK_SECRET,
  },
  pagarme: {
    env: pagarmeEnv,
    // Deliberately NOT in `required` above (same reasoning as
    // CHANNEX_API_KEY/webhookSecret): the Pagar.me account activates
    // 2026-09-21 (see server/CLAUDE.md and the migration design's "Buildable
    // today vs. blocked on the account"). The server, dev environment, and
    // test suite must keep working before that credential exists.
    // pagarmeClient.ts (PR 2/3) throws a clear PagarmeNotConfiguredError at
    // call time instead of failing at boot.
    secretKey: process.env.PAGARME_SECRET_KEY || undefined,
    publicKey: process.env.PAGARME_PUBLIC_KEY || undefined,
    webhookSecret: process.env.PAGARME_WEBHOOK_SECRET || undefined,
    baseUrl:
      pagarmeEnv === 'production'
        ? 'https://api.pagar.me/core/v5'
        : 'https://sdx-api.pagar.me/core/v5',
  },
  payments: {
    // Feature flag for the hard cutover (design D2/A10). Read once at
    // process start, same as every other env-sourced value here — flipping
    // it requires an env var change + `pm2 restart` (see design's
    // Rollback section), never a hot reload.
    provider: paymentsProvider,
  },
};
