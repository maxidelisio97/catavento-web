import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { createCustomer, createPayment, AsaasApiError } from '../asaasClient.js';

const createPaymentBodySchema = z.object({
  name: z.string().min(1),
  cpfCnpj: z.string().min(1),
  email: z.string().email().optional(),
  mobilePhone: z.string().optional(),
  value: z.number().positive(),
  dueDate: z.string().min(1),
  description: z.string().optional(),
  externalReference: z.string().optional(),
});

const paymentsPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/payments',
    { schema: { body: createPaymentBodySchema } },
    async (request, reply) => {
      const { name, cpfCnpj, email, mobilePhone, value, dueDate, description, externalReference } =
        request.body;

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

        return reply.status(201).send({
          paymentId: payment.id,
          status: payment.status,
          invoiceUrl: payment.invoiceUrl,
        });
      } catch (error) {
        if (error instanceof AsaasApiError) {
          return reply.status(502).send({ error: 'asaas_request_failed', details: error.body });
        }
        throw error;
      }
    },
  );
};

export default paymentsPlugin;
