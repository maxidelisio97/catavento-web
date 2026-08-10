import type { FastifyError, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { requireAuth } from '../auth/requireAuth.js';
import { blockIfMustChangePassword } from '../auth/blockIfMustChangePassword.js';
import { requirePermission } from '../auth/requirePermission.js';
import { AsaasApiError } from '../asaasClient.js';
import { PaymentAlreadyReceivedError } from '../reservations/createOrReusePayment.js';
import { OverpaymentError } from '../reservations/overpaymentGuard.js';
import {
  registerPayment,
  checkIn,
  checkOut,
  cancelReservation,
  markNoShow,
  addExtra,
  ReservationNotFoundError,
  ReservationNotPayableError,
  MissingCpfCnpjError,
  MissingIdempotencyKeyError,
  IdempotencyKeyReusedError,
  BalanceDueError,
  InvalidReservationTransitionError,
  type RegisterPaymentResult,
} from '../panel/reservationActions.js';

const paymentBodySchema = z.object({
  kind: z.enum(['deposit', 'balance', 'extra']),
  method: z.enum(['asaas_pix', 'asaas_card', 'cash', 'external', 'pix_manual']),
  amount_cents: z.number().int().positive(),
  cpf_cnpj: z.string().min(11).optional(),
  // Required for cash/external/pix_manual (enforced in registerPayment, not
  // here — the plugin doesn't know which methods need it, that's the
  // service's rule). Client generates it once per payment-form session, per
  // MissingIdempotencyKeyError's docstring.
  idempotency_key: z.string().uuid().optional(),
});

const pixDetailsSchema = z.object({
  encoded_image: z.string(),
  payload: z.string(),
  expiration_date: z.string(),
});

const paymentResponseSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('pix'), payment_id: z.string(), qr_code: pixDetailsSchema }),
  z.object({ method: z.literal('card'), payment_id: z.string(), invoice_url: z.string() }),
  z.object({ method: z.literal('cash'), payment_id: z.number(), status: z.literal('received') }),
  z.object({ method: z.literal('external'), payment_id: z.number(), status: z.literal('received') }),
  z.object({ method: z.literal('pix_manual'), payment_id: z.number(), status: z.literal('received') }),
]);

const codeParamsSchema = z.object({ code: z.string() });

const cancelBodySchema = z.object({ reason: z.string().max(500).optional() });

const extraBodySchema = z.object({
  concept: z.string().min(1).max(200),
  amount_cents: z.number().int().positive(),
});

const errorResponseSchema = z.object({ error: z.string() });
const balanceDueResponseSchema = z.object({ error: z.literal('BALANCE_DUE'), balance_due_cents: z.number() });
// discriminatedUnion, not union: a plain z.union tries branches in order and
// returns the first successful parse — errorResponseSchema's bare `{error}`
// shape parses successfully against a BALANCE_DUE payload too (extra keys
// are stripped by default), silently dropping balance_due_cents.
const checkOutErrorResponseSchema = z.discriminatedUnion('error', [
  balanceDueResponseSchema,
  z.object({ error: z.literal('INVALID_TRANSITION') }),
]);

function httpError(statusCode: number, message: string): FastifyError {
  const err = new Error(message) as FastifyError;
  err.statusCode = statusCode;
  err.code = 'PANEL_RESERVATION_ACTION_ERROR';
  err.name = 'PanelReservationActionError';
  return err;
}

function paymentResultToResponse(result: RegisterPaymentResult) {
  if (result.method === 'pix') {
    return {
      method: 'pix' as const,
      payment_id: result.paymentId,
      qr_code: {
        encoded_image: result.qrCode.encodedImage,
        payload: result.qrCode.payload,
        expiration_date: result.qrCode.expirationDate,
      },
    };
  }
  if (result.method === 'card') {
    return { method: 'card' as const, payment_id: result.paymentId, invoice_url: result.invoiceUrl };
  }
  return { method: result.method, payment_id: result.paymentId, status: result.status };
}

export interface PanelReservationActionsPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const panelReservationActionsPlugin: FastifyPluginAsync<PanelReservationActionsPluginOptions> = async (
  fastify,
  opts,
) => {
  const db = opts.db ?? prodDb;

  await fastify.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', requireAuth(db));
    protectedScope.addHook('onRequest', blockIfMustChangePassword());
    const typed = protectedScope.withTypeProvider<ZodTypeProvider>();

    // Mixed permissions in this one file (§ 4.4): payment/extra are
    // payments.*, the rest are reservations.* — gated per-route via the
    // route option instead of one scope-wide hook.
    typed.post(
      '/panel/reservations/:code/payment',
      {
        onRequest: [requirePermission(db, 'payments.charge')],
        schema: {
          params: codeParamsSchema,
          body: paymentBodySchema,
          // 200 = an existing payment with the same idempotency_key was
          // replayed back, not inserted again (see registerPayment).
          response: { 200: paymentResponseSchema, 201: paymentResponseSchema },
        },
      },
      async (request, reply) => {
        const { code } = request.params;
        const { kind, method, amount_cents, cpf_cnpj, idempotency_key } = request.body;

        try {
          const result = await registerPayment(db, {
            code,
            kind,
            method,
            amountCents: amount_cents,
            cpfCnpj: cpf_cnpj,
            idempotencyKey: idempotency_key,
            changedBy: request.user!.id,
          });

          reply.status('replayed' in result && result.replayed ? 200 : 201);
          return paymentResultToResponse(result);
        } catch (err) {
          if (err instanceof ReservationNotFoundError) throw httpError(404, 'RESERVATION_NOT_FOUND');
          if (err instanceof ReservationNotPayableError) throw httpError(409, 'RESERVATION_NOT_PAYABLE');
          if (err instanceof MissingCpfCnpjError) throw httpError(400, 'CPF_CNPJ_REQUIRED');
          if (err instanceof MissingIdempotencyKeyError) throw httpError(400, 'IDEMPOTENCY_KEY_REQUIRED');
          if (err instanceof IdempotencyKeyReusedError) throw httpError(409, 'IDEMPOTENCY_KEY_REUSED');
          if (err instanceof OverpaymentError) throw httpError(422, 'OVERPAYMENT');
          if (err instanceof PaymentAlreadyReceivedError) throw httpError(409, 'PAYMENT_ALREADY_RECEIVED');
          if (err instanceof AsaasApiError) {
            // Keep the real Asaas error out of the client response (it can
            // echo back request data) but not out of our own logs.
            request.log.warn({ status: err.status, body: err.body }, 'asaas_request_failed');
            throw httpError(502, 'asaas_request_failed');
          }
          throw err;
        }
      },
    );

    typed.post(
      '/panel/reservations/:code/check-in',
      {
        onRequest: [requirePermission(db, 'reservations.checkin')],
        schema: {
          params: codeParamsSchema,
          response: { 200: z.object({ status: z.literal('checked_in') }), 404: errorResponseSchema, 409: errorResponseSchema },
        },
      },
      async (request) => {
        const { code } = request.params;

        try {
          await checkIn(db, { code, changedBy: request.user!.id });
          return { status: 'checked_in' as const };
        } catch (err) {
          if (err instanceof ReservationNotFoundError) throw httpError(404, 'RESERVATION_NOT_FOUND');
          if (err instanceof InvalidReservationTransitionError) throw httpError(409, 'INVALID_TRANSITION');
          throw err;
        }
      },
    );

    typed.post(
      '/panel/reservations/:code/check-out',
      {
        onRequest: [requirePermission(db, 'reservations.checkout')],
        schema: {
          params: codeParamsSchema,
          response: {
            200: z.object({ status: z.literal('checked_out') }),
            404: errorResponseSchema,
            409: checkOutErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { code } = request.params;

        try {
          await checkOut(db, { code, changedBy: request.user!.id });
          return { status: 'checked_out' as const };
        } catch (err) {
          if (err instanceof ReservationNotFoundError) throw httpError(404, 'RESERVATION_NOT_FOUND');
          if (err instanceof InvalidReservationTransitionError) throw httpError(409, 'INVALID_TRANSITION');
          if (err instanceof BalanceDueError) {
            reply.status(409);
            return { error: 'BALANCE_DUE' as const, balance_due_cents: err.balanceDueCents };
          }
          throw err;
        }
      },
    );

    typed.post(
      '/panel/reservations/:code/cancel',
      {
        onRequest: [requirePermission(db, 'reservations.cancel')],
        schema: {
          params: codeParamsSchema,
          body: cancelBodySchema,
          response: { 200: z.object({ status: z.literal('cancelled') }), 404: errorResponseSchema, 409: errorResponseSchema },
        },
      },
      async (request) => {
        const { code } = request.params;

        try {
          await cancelReservation(db, { code, reason: request.body.reason, changedBy: request.user!.id });
          return { status: 'cancelled' as const };
        } catch (err) {
          if (err instanceof ReservationNotFoundError) throw httpError(404, 'RESERVATION_NOT_FOUND');
          if (err instanceof InvalidReservationTransitionError) throw httpError(409, 'INVALID_TRANSITION');
          throw err;
        }
      },
    );

    typed.post(
      '/panel/reservations/:code/no-show',
      {
        onRequest: [requirePermission(db, 'reservations.cancel')],
        schema: {
          params: codeParamsSchema,
          body: cancelBodySchema,
          response: { 200: z.object({ status: z.literal('no_show') }), 404: errorResponseSchema, 409: errorResponseSchema },
        },
      },
      async (request) => {
        const { code } = request.params;

        try {
          await markNoShow(db, { code, reason: request.body.reason, changedBy: request.user!.id });
          return { status: 'no_show' as const };
        } catch (err) {
          if (err instanceof ReservationNotFoundError) throw httpError(404, 'RESERVATION_NOT_FOUND');
          if (err instanceof InvalidReservationTransitionError) throw httpError(409, 'INVALID_TRANSITION');
          throw err;
        }
      },
    );
    typed.post(
      '/panel/reservations/:code/extra',
      {
        onRequest: [requirePermission(db, 'payments.extra')],
        schema: {
          params: codeParamsSchema,
          body: extraBodySchema,
          response: {
            201: z.object({ extra_id: z.number(), total_cents: z.number() }),
            404: errorResponseSchema,
            409: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { code } = request.params;
        const { concept, amount_cents } = request.body;

        try {
          const result = await addExtra(db, { code, concept, amountCents: amount_cents, changedBy: request.user!.id });
          reply.status(201);
          return { extra_id: result.extraId, total_cents: result.totalCents };
        } catch (err) {
          if (err instanceof ReservationNotFoundError) throw httpError(404, 'RESERVATION_NOT_FOUND');
          if (err instanceof ReservationNotPayableError) throw httpError(409, 'RESERVATION_NOT_PAYABLE');
          throw err;
        }
      },
    );
  });
};

export default panelReservationActionsPlugin;
