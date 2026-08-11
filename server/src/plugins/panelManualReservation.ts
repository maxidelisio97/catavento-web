/**
 * POST /panel/reservations/manual — SPEC-modulo-7-gestion-operativa.md § 7.2, § 7.4.
 *
 * Field naming deviation from the spec's literal body (approved in-code,
 * same class of deviation as 7A's payments.method note): the spec lists a
 * single `guestContact` field, but `reservations` already has separate
 * `guest_email`/`guest_phone` columns (M3/M4) and the public flow validates
 * them separately. Splitting into `guest_email`/`guest_phone` (both
 * optional, unlike the public flow where email is required) avoids a second
 * "contact" concept meaning the same thing as those two columns.
 */
import type { FastifyError, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { requireAuth } from '../auth/requireAuth.js';
import { blockIfMustChangePassword } from '../auth/blockIfMustChangePassword.js';
import { requirePermission } from '../auth/requirePermission.js';
import {
  createManualReservation,
  RoomNotFoundError,
  AdultsOnlyRoomError,
  PetsNotAllowedRoomError,
  MissingPaymentMethodError,
  ManualCommercialWarningError,
  NoAvailabilityError,
  MinStayNotMetError,
} from '../panel/createManualReservation.js';
import { getReservationDetail } from '../panel/reservationDetailQuery.js';
import { reservationDetailResponseSchema } from './panelTapeChart.js';

// Same caps as the public flow (plugins/reservations.ts) — defense in
// depth, not a business rule.
const MAX_CHILDREN = 8;
const MAX_BABIES = 4;

const childAgeSchema = z.number().int().min(3).max(17);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const manualReservationBodySchema = z
  .object({
    room_id: z.number().int().positive(),
    check_in: dateSchema,
    check_out: dateSchema,
    adults: z.number().int().min(1),
    children: z.number().int().min(0).max(MAX_CHILDREN).default(0),
    children_ages: z.array(childAgeSchema).max(MAX_CHILDREN).default([]),
    babies: z.number().int().min(0).max(MAX_BABIES).default(0),
    pets: z.boolean().default(false),
    guest_name: z.string().min(3),
    guest_email: z.string().email().optional(),
    guest_phone: z.string().min(8).optional(),
    notes: z.string().max(500).optional(),
    payment_status: z.enum(['none', 'deposit_paid', 'paid_full']),
    payment_method: z.enum(['cash', 'external', 'pix_manual']).optional(),
    override_total_cents: z.number().int().min(0).optional(),
    force_commercial: z.boolean().optional(),
  })
  .refine((data) => data.children_ages.length === data.children, {
    message: 'children_ages must have exactly one age per child',
    path: ['children_ages'],
  });

const errorResponseSchema = z.object({ error: z.string() });

const commercialWarningResponseSchema = z.object({
  error: z.literal('COMMERCIAL_WARNING'),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});

function httpError(statusCode: number, message: string): FastifyError {
  const err = new Error(message) as FastifyError;
  err.statusCode = statusCode;
  err.code = 'PANEL_MANUAL_RESERVATION_ERROR';
  err.name = 'PanelManualReservationError';
  return err;
}

export interface PanelManualReservationPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const panelManualReservationPlugin: FastifyPluginAsync<PanelManualReservationPluginOptions> = async (
  fastify,
  opts,
) => {
  const db = opts.db ?? prodDb;

  await fastify.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', requireAuth(db));
    protectedScope.addHook('onRequest', blockIfMustChangePassword());
    protectedScope.addHook('onRequest', requirePermission(db, 'reservations.create_manual'));
    const typed = protectedScope.withTypeProvider<ZodTypeProvider>();

    typed.post(
      '/panel/reservations/manual',
      {
        schema: {
          body: manualReservationBodySchema,
          response: {
            201: reservationDetailResponseSchema,
            400: errorResponseSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
            422: commercialWarningResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const body = request.body;

        try {
          const result = await createManualReservation(db, {
            roomId: body.room_id,
            checkIn: body.check_in,
            checkOut: body.check_out,
            adults: body.adults,
            children: body.children,
            childrenAges: body.children_ages,
            babies: body.babies,
            pets: body.pets,
            guestName: body.guest_name,
            guestEmail: body.guest_email,
            guestPhone: body.guest_phone,
            notes: body.notes,
            paymentStatus: body.payment_status,
            paymentMethod: body.payment_method,
            overrideTotalCents: body.override_total_cents,
            forceCommercial: body.force_commercial,
            createdBy: request.user!.id,
          });

          const detail = await getReservationDetail(db, result.id);
          // Can't actually be null: just created, inside this same request.
          if (!detail) throw new Error('unreachable: manual reservation vanished after creation');

          reply.status(201);
          return detail;
        } catch (err) {
          if (err instanceof RoomNotFoundError) throw httpError(404, 'ROOM_NOT_FOUND');
          if (err instanceof AdultsOnlyRoomError) throw httpError(409, 'ADULTS_ONLY_ROOM');
          if (err instanceof PetsNotAllowedRoomError) throw httpError(409, 'PETS_NOT_ALLOWED');
          if (err instanceof MissingPaymentMethodError) throw httpError(400, 'PAYMENT_METHOD_REQUIRED');
          if (err instanceof NoAvailabilityError) throw httpError(409, 'NO_AVAILABILITY');
          if (err instanceof MinStayNotMetError) {
            throw httpError(
              400,
              `MIN_STAY_NOT_MET: stay of ${err.requestedNights} nights is below the ${err.requiredMinStay}-night minimum`,
            );
          }
          if (err instanceof ManualCommercialWarningError) {
            reply.status(422);
            return { error: 'COMMERCIAL_WARNING' as const, warnings: err.warnings };
          }
          throw err;
        }
      },
    );
  });
};

export default panelManualReservationPlugin;
