import type { FastifyError, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { createReservationWithCode } from '../reservations/createReservationWithCode.js';
import { NoAvailabilityError, MinStayNotMetError } from '../availability/createReservation.js';
import { eachNightUTC } from '../shared/dateUtils.js';

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

const reservationResponseSchema = z.object({
  code: z.string(),
  status: z.enum(['pending_payment', 'confirmed', 'cancelled', 'expired']),
  check_in: z.string(),
  check_out: z.string(),
  guests: z.number(),
  room: z.object({ id: z.number(), name: z.string() }),
  total_cents: z.number(),
  expires_at: z.string().nullable(),
});

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
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
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
    { schema: { params: z.object({ code: z.string() }), response: { 200: reservationResponseSchema } } },
    async (request) => {
      const { code } = request.params;

      const row = await db
        .selectFrom('reservations')
        .innerJoin('rooms', 'rooms.id', 'reservations.room_id')
        .select([
          'reservations.status',
          sql<string>`reservations.check_in::text`.as('check_in'),
          sql<string>`reservations.check_out::text`.as('check_out'),
          'reservations.guests',
          'reservations.total_cents',
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

      return {
        code,
        status: isExpired ? ('expired' as const) : (row.status as 'pending_payment' | 'confirmed' | 'cancelled'),
        check_in: row.check_in,
        check_out: row.check_out,
        guests: row.guests,
        room: { id: row.room_id, name: row.room_name },
        total_cents: row.total_cents,
        expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      };
    },
  );
};

export default reservationsPlugin;
