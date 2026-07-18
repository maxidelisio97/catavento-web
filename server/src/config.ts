import 'dotenv/config';

const required = ['ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN'] as const;

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`);
  }
}

type AsaasEnv = 'sandbox' | 'production';

const env: AsaasEnv = process.env.ASAAS_ENV === 'production' ? 'production' : 'sandbox';

export const config = {
  port: Number(process.env.PORT) || 3001,
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
