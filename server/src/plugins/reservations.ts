import type { FastifyError, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { createReservationWithCode } from '../reservations/createReservationWithCode.js';
import { NoAvailabilityError, MinStayNotMetError } from '../availability/createReservation.js';
import { eachNightUTC } from '../shared/dateUtils.js';
import { getBusinessSettings } from '../settings/settings.js';
import {
  createOrReusePayment,
  PaymentAlreadyReceivedError,
  type PaymentDetails,
} from '../reservations/createOrReusePayment.js';
import { getPayment, getPixQrCode, AsaasApiError } from '../asaasClient.js';

const MAX_NIGHTS = 60;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const createReservationBodySchema = z.object({
  room_id: z.number().int().positive(),
  check_in: dateSchema,
  check_out: dateSchema,
  guests: z.number().int().min(1),
  guest_name: z.string().min(3),
  guest_email: z.string().email(),
  guest_phone: z.string().min(8),
  notes: z.string().max(500).optional(),
});

const reservationStatusSchema = z.enum([
  'pending_payment',
  'confirmed',
  'cancelled',
  'expired',
  'payment_conflict',
]);

const reservationResponseSchema = z.object({
  code: z.string(),
  status: reservationStatusSchema,
  check_in: z.string(),
  check_out: z.string(),
  guests: z.number(),
  room: z.object({ id: z.number(), name: z.string() }),
  total_cents: z.number(),
  deposit_cents: z.number().nullable(),
  expires_at: z.string().nullable(),
});

const pixDetailsSchema = z.object({
  encoded_image: z.string(),
  payload: z.string(),
  expiration_date: z.string(),
});

const reservationDetailResponseSchema = reservationResponseSchema.extend({
  payment_status: z.enum(['pending', 'received', 'failed', 'refunded']).nullable(),
  payment: z
    .object({
      method: z.enum(['pix', 'card']),
      pix: pixDetailsSchema.optional(),
      invoice_url: z.string().optional(),
    })
    .nullable(),
});

const createPaymentBodySchema = z.object({
  method: z.enum(['pix', 'card']),
  cpf_cnpj: z.string().min(11),
});

const paymentResponseSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('pix'),
    payment_id: z.string(),
    qr_code: pixDetailsSchema,
  }),
  z.object({
    method: z.literal('card'),
    payment_id: z.string(),
    invoice_url: z.string(),
  }),
]);

function httpError(statusCode: number, message: string): FastifyError {
  const err = new Error(message) as FastifyError;
  err.statusCode = statusCode;
  err.code = 'RESERVATION_ERROR';
  err.name = 'ReservationError';
  return err;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function paymentDetailsToResponse(details: PaymentDetails) {
  if (details.method === 'pix') {
    return {
      method: 'pix' as const,
      payment_id: details.paymentId,
      qr_code: {
        encoded_image: details.qrCode.encodedImage,
        payload: details.qrCode.payload,
        expiration_date: details.qrCode.expirationDate,
      },
    };
  }
  return { method: 'card' as const, payment_id: details.paymentId, invoice_url: details.invoiceUrl };
}

export interface ReservationsPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const reservationsPlugin: FastifyPluginAsync<ReservationsPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/reservations',
    { schema: { body: createReservationBodySchema, response: { 201: reservationResponseSchema } } },
    async (request, reply) => {
      const { room_id, check_in, check_out, guests, guest_name, guest_email, guest_phone, notes } = request.body;

      if (check_out <= check_in) {
        throw httpError(400, 'check_out must be after check_in');
      }
      const nights = eachNightUTC(check_in, check_out).length;
      if (nights > MAX_NIGHTS) {
        throw httpError(400, `Range cannot exceed ${MAX_NIGHTS} nights`);
      }
      if (check_in < todayISO()) {
        throw httpError(400, 'check_in cannot be in the past');
      }

      const room = await db
        .selectFrom('rooms')
        .select(['id', 'name', 'capacity'])
        .where('id', '=', room_id)
        .where('active', '=', true)
        .executeTakeFirst();

      if (!room) {
        throw httpError(400, 'Room not found or inactive');
      }
      if (guests > room.capacity) {
        throw httpError(400, `guests exceeds room capacity (${room.capacity})`);
      }

      try {
        const { depositPercent, holdMinutes } = await getBusinessSettings(db);
        const expiresAt = new Date(Date.now() + holdMinutes * 60 * 1000);
        const result = await createReservationWithCode(db, {
          roomId: room_id,
          checkIn: check_in,
          checkOut: check_out,
          guests,
          guestName: guest_name,
          guestEmail: guest_email,
          guestPhone: guest_phone,
          notes,
          expiresAt,
          depositPercent,
        });

        reply.status(201);
        return {
          code: result.code!,
          status: 'pending_payment' as const,
          check_in,
          check_out,
          guests,
          room: { id: room.id, name: room.name },
          total_cents: result.totalCents,
          deposit_cents: result.depositCents,
          expires_at: expiresAt.toISOString(),
        };
      } catch (err) {
        if (err instanceof NoAvailabilityError) {
          throw httpError(409, 'NO_AVAILABILITY');
        }
        if (err instanceof MinStayNotMetError) {
          throw httpError(
            400,
            `Stay of ${err.requestedNights} nights is below the ${err.requiredMinStay}-night minimum`,
          );
        }
        throw err;
      }
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/reservations/:code',
    { schema: { params: z.object({ code: z.string() }), response: { 200: reservationDetailResponseSchema } } },
    async (request) => {
      const { code } = request.params;

      const row = await db
        .selectFrom('reservations')
        .innerJoin('rooms', 'rooms.id', 'reservations.room_id')
        .select([
          'reservations.id as reservation_id',
          'reservations.status',
          sql<string>`reservations.check_in::text`.as('check_in'),
          sql<string>`reservations.check_out::text`.as('check_out'),
          'reservations.guests',
          'reservations.total_cents',
          'reservations.deposit_cents',
          'reservations.expires_at',
          'rooms.id as room_id',
          'rooms.name as room_name',
        ])
        .where('reservations.code', '=', code)
        .executeTakeFirst();

      if (!row) {
        throw httpError(404, 'Reservation not found');
      }

      const isExpired =
        row.status === 'pending_payment' && row.expires_at != null && new Date(row.expires_at) <= new Date();

      const activePayment = await db
        .selectFrom('payments')
        .selectAll()
        .where('reservation_id', '=', row.reservation_id)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();

      let payment: z.infer<typeof reservationDetailResponseSchema>['payment'] = null;
      if (activePayment) {
        payment = { method: activePayment.method as 'pix' | 'card' };

        // Only worth a live Asaas round-trip while the payment is still
        // actionable by the guest (pending) — avoids hammering Asaas from
        // frontend polling once the payment is settled either way.
        if (activePayment.status === 'pending') {
          try {
            if (activePayment.method === 'pix') {
              const qr = await getPixQrCode(activePayment.asaas_payment_id);
              payment.pix = {
                encoded_image: qr.encodedImage,
                payload: qr.payload,
                expiration_date: qr.expirationDate,
              };
            } else {
              const remote = await getPayment(activePayment.asaas_payment_id);
              payment.invoice_url = remote.invoiceUrl;
            }
          } catch (err) {
            if (!(err instanceof AsaasApiError)) throw err;
            // Don't log `err` whole — AsaasApiError.body carries the guest's
            // PII (name/email/phone/CPF) echoed back by Asaas.
            fastify.log.warn({ status: err.status }, 'failed to refresh live payment details from Asaas');
          }
        }
      }

      return {
        code,
        status: isExpired
          ? ('expired' as const)
          : (row.status as 'pending_payment' | 'confirmed' | 'cancelled' | 'payment_conflict'),
        check_in: row.check_in,
        check_out: row.check_out,
        guests: row.guests,
        room: { id: row.room_id, name: row.room_name },
        total_cents: row.total_cents,
        deposit_cents: row.deposit_cents,
        expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
        payment_status: activePayment ? (activePayment.status as 'pending' | 'received' | 'failed' | 'refunded') : null,
        payment,
      };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/reservations/:code/payment',
    {
      schema: {
        params: z.object({ code: z.string() }),
        body: createPaymentBodySchema,
        response: { 201: paymentResponseSchema },
      },
    },
    async (request, reply) => {
      const { code } = request.params;
      const { method, cpf_cnpj } = request.body;

      const row = await db
        .selectFrom('reservations')
        .select(['id', 'status', 'expires_at', 'deposit_cents', 'guest_name', 'guest_email', 'guest_phone'])
        .where('code', '=', code)
        .executeTakeFirst();

      if (!row) {
        throw httpError(404, 'Reservation not found');
      }

      if (row.status !== 'pending_payment' || row.expires_at == null || new Date(row.expires_at) <= new Date()) {
        throw httpError(409, 'RESERVATION_NOT_PAYABLE');
      }
      if (row.deposit_cents == null) {
        throw httpError(409, 'DEPOSIT_NOT_CONFIGURED');
      }
      const expiresAt = row.expires_at;

      try {
        const details = await createOrReusePayment(db, {
          reservationId: row.id,
          code,
          method,
          depositCents: row.deposit_cents,
          dueDate: new Date(expiresAt).toISOString().slice(0, 10),
          guestName: row.guest_name ?? '',
          guestEmail: row.guest_email ?? '',
          guestPhone: row.guest_phone ?? '',
          cpfCnpj: cpf_cnpj,
        });

        reply.status(201);
        return paymentDetailsToResponse(details);
      } catch (err) {
        if (err instanceof PaymentAlreadyReceivedError) {
          throw httpError(409, 'PAYMENT_ALREADY_RECEIVED');
        }
        if (err instanceof AsaasApiError) {
          // Keep the real Asaas error out of the client response (it can
          // echo back request data) but not out of our own logs — losing it
          // here means nobody can tell why a charge failed without going to
          // the Asaas dashboard.
          request.log.warn({ status: err.status, body: err.body }, 'asaas_request_failed');
          throw httpError(502, 'asaas_request_failed');
        }
        throw err;
      }
    },
  );
};

export default reservationsPlugin;
