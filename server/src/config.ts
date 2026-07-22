import 'dotenv/config';

const required = ['ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN', 'DATABASE_URL', 'FRONTEND_BASE_URL'] as const;

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`);
  }
}

type AsaasEnv = 'sandbox' | 'production';

const env: AsaasEnv = process.env.ASAAS_ENV === 'production' ? 'production' : 'sandbox';

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
};
