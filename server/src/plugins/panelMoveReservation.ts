/**
 * POST /panel/reservations/:code/move-night, /move-stay — SPEC-modulo-7 § 4.4.
 * GET /panel/reservations/:code/move-options — read-only helper for the
 * ficha's unit selector (§ 4.5), not part of the spec's endpoint list but
 * needed to populate it (see moveOptionsQuery.ts doc comment: informational
 * only, never a hold).
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
  moveNight,
  moveStay,
  ReservationNotFoundError,
  ReservationNotMovableError,
  NightNotInStayError,
  DestinationUnitNotFoundError,
  PhysicalConflictError,
  HardSpaceRuleViolationError,
  CommercialWarningError,
} from '../panel/moveReservation.js';
import { getMoveOptions } from '../panel/moveOptionsQuery.js';
import { getReservationDetail } from '../panel/reservationDetailQuery.js';
import { reservationDetailResponseSchema } from './panelTapeChart.js';

const codeParamsSchema = z.object({ code: z.string() });

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const moveNightBodySchema = z.object({
  night: dateSchema,
  toUnitId: z.number().int().positive(),
  force_commercial: z.boolean().optional(),
});

const moveStayBodySchema = z.object({
  toUnitId: z.number().int().positive(),
  force_commercial: z.boolean().optional(),
});

const errorResponseSchema = z.object({ error: z.string() });

const move422ResponseSchema = z.object({
  error: z.literal('COMMERCIAL_WARNING'),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});

const moveOptionUnitSchema = z.object({
  unit_id: z.number(),
  unit_label: z.string(),
  room_type_id: z.number(),
  room_type_name: z.string(),
  capacity: z.number(),
  adults_only: z.boolean(),
  occupied_nights: z.array(z.string()),
  free_for_all_nights: z.boolean(),
});

const moveOptionsResponseSchema = z.object({
  nights: z.array(z.string()),
  units: z.array(moveOptionUnitSchema),
});

function httpError(statusCode: number, message: string): FastifyError {
  const err = new Error(message) as FastifyError;
  err.statusCode = statusCode;
  err.code = 'PANEL_MOVE_RESERVATION_ERROR';
  err.name = 'PanelMoveReservationError';
  return err;
}

export interface PanelMoveReservationPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const panelMoveReservationPlugin: FastifyPluginAsync<PanelMoveReservationPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  await fastify.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', requireAuth(db));
    protectedScope.addHook('onRequest', blockIfMustChangePassword());
    // move-options is a read-only helper, but it's scoped to feed exactly
    // the mover UI (§ 4.4 barrido note) — gated the same as the actions it
    // exists for, not reservations.view.
    protectedScope.addHook('onRequest', requirePermission(db, 'reservations.move'));
    const typed = protectedScope.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/panel/reservations/:code/move-options',
      {
        schema: {
          params: codeParamsSchema,
          response: { 200: moveOptionsResponseSchema, 404: errorResponseSchema },
        },
      },
      async (request) => {
        const options = await getMoveOptions(db, request.params.code);
        if (!options) throw httpError(404, 'RESERVATION_NOT_FOUND');
        return options;
      },
    );

    typed.post(
      '/panel/reservations/:code/move-night',
      {
        schema: {
          params: codeParamsSchema,
          body: moveNightBodySchema,
          response: {
            200: reservationDetailResponseSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
            422: move422ResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { code } = request.params;
        const { night, toUnitId, force_commercial } = request.body;

        try {
          await moveNight(db, { code, night, toUnitId, forceCommercial: force_commercial });
        } catch (err) {
          if (err instanceof ReservationNotFoundError) throw httpError(404, 'RESERVATION_NOT_FOUND');
          if (err instanceof ReservationNotMovableError) throw httpError(409, 'RESERVATION_NOT_MOVABLE');
          if (err instanceof NightNotInStayError) throw httpError(409, 'NIGHT_NOT_IN_STAY');
          if (err instanceof DestinationUnitNotFoundError) throw httpError(404, 'DESTINATION_UNIT_NOT_FOUND');
          if (err instanceof PhysicalConflictError) throw httpError(409, 'PHYSICAL_CONFLICT');
          if (err instanceof HardSpaceRuleViolationError) throw httpError(409, err.code);
          if (err instanceof CommercialWarningError) {
            reply.status(422);
            return { error: 'COMMERCIAL_WARNING' as const, warnings: err.warnings };
          }
          throw err;
        }

        // getReservationDetail reads by numeric id (panelTapeChart.ts's GET
        // /panel/reservations/:id); resolve it from the code we already have.
        const detail = await getReservationDetailByCode(db, code);
        reply.status(200);
        return detail;
      },
    );

    typed.post(
      '/panel/reservations/:code/move-stay',
      {
        schema: {
          params: codeParamsSchema,
          body: moveStayBodySchema,
          response: {
            200: reservationDetailResponseSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
            422: move422ResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { code } = request.params;
        const { toUnitId, force_commercial } = request.body;

        try {
          await moveStay(db, { code, toUnitId, forceCommercial: force_commercial });
        } catch (err) {
          if (err instanceof ReservationNotFoundError) throw httpError(404, 'RESERVATION_NOT_FOUND');
          if (err instanceof ReservationNotMovableError) throw httpError(409, 'RESERVATION_NOT_MOVABLE');
          if (err instanceof DestinationUnitNotFoundError) throw httpError(404, 'DESTINATION_UNIT_NOT_FOUND');
          if (err instanceof PhysicalConflictError) throw httpError(409, 'PHYSICAL_CONFLICT');
          if (err instanceof HardSpaceRuleViolationError) throw httpError(409, err.code);
          if (err instanceof CommercialWarningError) {
            reply.status(422);
            return { error: 'COMMERCIAL_WARNING' as const, warnings: err.warnings };
          }
          throw err;
        }

        const detail = await getReservationDetailByCode(db, code);
        reply.status(200);
        return detail;
      },
    );
  });
};

async function getReservationDetailByCode(db: Kysely<DB>, code: string) {
  const row = await db.selectFrom('reservations').select('id').where('code', '=', code).executeTakeFirstOrThrow();
  const detail = await getReservationDetail(db, row.id);
  // Can't actually be null here: the reservation was just found and written
  // to by moveNight/moveStay under the same code, inside the same request.
  if (!detail) throw new Error('unreachable: reservation vanished after move');
  return detail;
}

export default panelMoveReservationPlugin;
