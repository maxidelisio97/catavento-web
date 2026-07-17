import { Router } from 'express';
import { createCustomer, createPayment, AsaasApiError } from '../asaasClient.js';

export const paymentsRouter = Router();

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

paymentsRouter.post('/payments', async (req, res) => {
  const { name, cpfCnpj, email, mobilePhone, value, dueDate, description, externalReference } =
    req.body ?? {};

  if (!isNonEmptyString(name) || !isNonEmptyString(cpfCnpj)) {
    return res.status(400).json({ error: 'name and cpfCnpj are required' });
  }
  if (typeof value !== 'number' || value <= 0) {
    return res.status(400).json({ error: 'value must be a positive number' });
  }
  if (!isNonEmptyString(dueDate)) {
    return res.status(400).json({ error: 'dueDate is required (YYYY-MM-DD)' });
  }

  try {
    const customer = await createCustomer({ name, cpfCnpj, email, mobilePhone });

    const payment = await createPayment({
      customer: customer.id,
      billingType: 'PIX',
      value,
      dueDate,
      description,
      externalReference,
    });

    res.status(201).json({
      paymentId: payment.id,
      status: payment.status,
      invoiceUrl: payment.invoiceUrl,
    });
  } catch (error) {
    if (error instanceof AsaasApiError) {
      return res.status(502).json({ error: 'asaas_request_failed', details: error.body });
    }
    throw error;
  }
});
