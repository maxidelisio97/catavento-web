import { config } from '../src/config.js';

const paymentId = process.argv[2];

if (!paymentId) {
  console.error('Usage: tsx scripts/confirm-sandbox-payment.ts <paymentId>');
  process.exit(1);
}

if (config.asaas.env !== 'sandbox') {
  console.error('Refusing to run: ASAAS_ENV is not sandbox.');
  process.exit(1);
}

const response = await fetch(`${config.asaas.baseUrl}/v3/sandbox/payment/${paymentId}/confirm`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    access_token: config.asaas.apiKey,
  },
});

const data = await response.json();
console.log(response.status, JSON.stringify(data, null, 2));
