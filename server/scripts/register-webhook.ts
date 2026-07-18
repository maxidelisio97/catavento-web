import { config } from '../src/config.js';

const response = await fetch(`${config.asaas.baseUrl}/v3/webhooks`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    access_token: config.asaas.apiKey,
  },
  body: JSON.stringify({
    name: 'Catavento Payments',
    url: 'https://cataventotaiba.com/api/webhooks/asaas',
    email: 'maxidelisio@hotmail.com',
    enabled: true,
    interrupted: false,
    apiVersion: 3,
    authToken: config.asaas.webhookToken,
    sendType: 'SEQUENTIALLY',
    events: [
      'PAYMENT_CREATED',
      'PAYMENT_CONFIRMED',
      'PAYMENT_RECEIVED',
      'PAYMENT_OVERDUE',
      'PAYMENT_DELETED',
      'PAYMENT_REFUNDED',
    ],
  }),
});

const data = await response.json();
console.log(response.status, JSON.stringify(data, null, 2));
