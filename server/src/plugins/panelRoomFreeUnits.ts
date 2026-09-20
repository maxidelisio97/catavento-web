/**
 * GET /panel/rooms/:roomId/free-units — design: nova-reserva-panel, D5-D9.
 *
 * Composes `fetchRoomStayData` + `findFreeUnits` only (D6 — no commercial
 * gates: closed/min-stay belong to the POST, which can be forced; using
 * them here would hide units staff may legitimately force). Returns ALL
 * active units for the room with a `free` boolean (D5 — not free-only), so
 * the panel's picker can show occupied units disabled instead of omitting
 * them silently. Never calls `sweepStaleReservationNights` (D7 — a GET must
 * not write; the result is conservative, may show a stale-pending unit as
 * occupied, and self-heals on the next create).
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
import { fetchRoomStayData } from '../availability/repository.js';
import { findFreeUnits } from '../availability/findFreeUnits.js';
import { calendarDateSchema } from '../shared/calendarDateSchema.js';

const roomIdParamsSchema = z.object({ roomId: z.coerce.number().int().positive() });

const freeUnitsQuerySchema = z.object({
  check_in: z.string(),
  check_out: z.string(),
});

const freeUnitsResponseSchema = z.object({
  room_id: z.number(),
  check_in: z.string(),
  check_out: z.string(),
  units: z.array(z.object({ id: z.number(), label: z.string(), free: z.boolean() })),
});

const errorResponseSchema = z.object({ error: z.string() });

function httpError(statusCode: number, message: string): FastifyError {
  const err = new Error(message) as FastifyError;
  err.statusCode = statusCode;
  err.code = 'PANEL_ROOM_FREE_UNITS_ERROR';
  err.name = 'PanelRoomFreeUnitsError';
  return err;
}

export interface PanelRoomFreeUnitsPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const panelRoomFreeUnitsPlugin: FastifyPluginAsync<PanelRoomFreeUnitsPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  await fastify.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', requireAuth(db));
    protectedScope.addHook('onRequest', blockIfMustChangePassword());
    protectedScope.addHook('onRequest', requirePermission(db, 'reservations.create_manual'));
    const typed = protectedScope.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/panel/rooms/:roomId/free-units',
      {
        schema: {
          params: roomIdParamsSchema,
          querystring: freeUnitsQuerySchema,
          response: {
            200: freeUnitsResponseSchema,
            400: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request) => {
        const { roomId } = request.params;
        const { check_in: checkIn, check_out: checkOut } = request.query;

        const checkInResult = calendarDateSchema.safeParse(checkIn);
        const checkOutResult = calendarDateSchema.safeParse(checkOut);
        if (!checkInResult.success || !checkOutResult.success || checkOut <= checkIn) {
          throw httpError(400, 'INVALID_DATE_RANGE');
        }

        // Deliberately no sweepStaleReservationNights call here (D7) — a
        // GET must not write.
        const stayData = await fetchRoomStayData(db, roomId, checkIn, checkOut);
        if (!stayData) throw httpError(404, 'ROOM_NOT_FOUND');

        const freeUnits = findFreeUnits(stayData.roomUnits, stayData.unitReservations, checkIn, checkOut);
        const freeUnitIds = new Set(freeUnits.map((unit) => unit.id));

        const units = stayData.roomUnits
          .map((unit) => ({ id: unit.id, label: unit.label, free: freeUnitIds.has(unit.id) }))
          .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

        return { room_id: roomId, check_in: checkIn, check_out: checkOut, units };
      },
    );
  });
};

export default panelRoomFreeUnitsPlugin;
