import { config } from './config.js';

export class AsaasApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`Asaas API error (${status}): ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

interface AsaasRequestOptions {
  method?: string;
  body?: unknown;
}

async function asaasRequest<T>(path: string, { method = 'GET', body }: AsaasRequestOptions = {}): Promise<T> {
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

  return data as T;
}

export interface AsaasCustomer {
  name: string;
  cpfCnpj: string;
  email?: string;
  mobilePhone?: string;
}

export interface AsaasCustomerResponse {
  id: string;
  [key: string]: unknown;
}

export interface AsaasPaymentCallback {
  successUrl: string;
  autoRedirect: boolean;
}

export interface AsaasPaymentRequest {
  customer: string;
  billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD' | 'UNDEFINED';
  value: number;
  dueDate: string;
  description?: string;
  externalReference?: string;
  /** Redirects the guest back to our site after paying a hosted invoice (card) or PIX. */
  callback?: AsaasPaymentCallback;
}

export interface AsaasPaymentResponse {
  id: string;
  /** e.g. PENDING, RECEIVED, CONFIRMED, OVERDUE, REFUNDED — see Asaas docs. */
  status: string;
  invoiceUrl: string;
  [key: string]: unknown;
}

export interface AsaasPixQrCodeResponse {
  encodedImage: string;
  payload: string;
  expirationDate: string;
  [key: string]: unknown;
}

export function createCustomer(customer: AsaasCustomer): Promise<AsaasCustomerResponse> {
  return asaasRequest('/v3/customers', { method: 'POST', body: customer });
}

export function createPayment(payment: AsaasPaymentRequest): Promise<AsaasPaymentResponse> {
  return asaasRequest('/v3/payments', { method: 'POST', body: payment });
}

export function getPayment(paymentId: string): Promise<AsaasPaymentResponse> {
  return asaasRequest(`/v3/payments/${paymentId}`);
}

export function getPixQrCode(paymentId: string): Promise<AsaasPixQrCodeResponse> {
  return asaasRequest(`/v3/payments/${paymentId}/pixQrCode`);
}
