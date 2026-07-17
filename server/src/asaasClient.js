import { config } from './config.js';

class AsaasApiError extends Error {
  constructor(status, body) {
    super(`Asaas API error (${status}): ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

async function asaasRequest(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${config.asaas.baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      access_token: config.asaas.apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new AsaasApiError(response.status, data);
  }

  return data;
}

export function createCustomer(customer) {
  return asaasRequest('/v3/customers', { method: 'POST', body: customer });
}

export function createPayment(payment) {
  return asaasRequest('/v3/payments', { method: 'POST', body: payment });
}

export function getPayment(paymentId) {
  return asaasRequest(`/v3/payments/${paymentId}`);
}

export { AsaasApiError };
