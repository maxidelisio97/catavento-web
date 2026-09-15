import type { FastifyError, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { requireAuth } from '../auth/requireAuth.js';
import { blockIfMustChangePassword } from '../auth/blockIfMustChangePassword.js';
import { requirePermission } from '../auth/requirePermission.js';
import { schedulePushAvailability } from '../channex/pushAvailability.js';
import { RESYNC_HORIZON_DAYS } from '../channex/resyncAvailability.js';
import { addDaysUTC, formatDateUTC, parseDateUTC, todayISO } from '../shared/dateUtils.js';

const roomRateRowSchema = z.object({
  id: z.number(),
  occupancy: z.number(),
  weekday_cents: z.number(),
  weekend_cents: z.number(),
});

const roomRatesGroupSchema = z.object({
  room_id: z.number(),
  room_name: z.string(),
  rates: z.array(roomRateRowSchema),
});

const roomRatesResponseSchema = z.array(roomRatesGroupSchema);

// Only weekday_cents/weekend_cents are patchable — occupancy and room_id are
// deliberately absent from the body, so the contract itself rules out
// creating/moving rows (SPEC-modulo-8-configuracion.md § 5.2, § 2: occupancy
// rows are owned by M1, 8B only edits prices of existing rows).
const roomRatePatchSchema = z
  .object({
    weekday_cents: z.number().int().min(0),
    weekend_cents: z.number().int().min(0),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Body must include at least one field' });

const errorResponseSchema = z.object({ error: z.string() });

function httpError(statusCode: number, message: string): FastifyError {
  const err = new Error(message) as FastifyError;
  err.statusCode = statusCode;
  err.code = 'PANEL_ROOM_RATES_ERROR';
  err.name = 'PanelRoomRatesError';
  return err;
}

export interface PanelRoomRatesPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const panelRoomRatesPlugin: FastifyPluginAsync<PanelRoomRatesPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  await fastify.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', requireAuth(db));
    protectedScope.addHook('onRequest', blockIfMustChangePassword());
    protectedScope.addHook('onRequest', requirePermission(db, 'config.settings'));
    const typed = protectedScope.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/panel/room-rates',
      { schema: { response: { 200: roomRatesResponseSchema } } },
      async () => {
        const rooms = await db
          .selectFrom('rooms')
          .select(['id', 'name'])
          .where('active', '=', true)
          .orderBy('sort_order')
          .execute();

        const rates = await db
          .selectFrom('room_rates')
          .select(['id', 'room_id', 'occupancy', 'weekday_cents', 'weekend_cents'])
          .orderBy('occupancy')
          .execute();

        return rooms.map((room) => ({
          room_id: room.id,
          room_name: room.name,
          rates: rates
            .filter((rate) => rate.room_id === room.id)
            .map((rate) => ({
              id: rate.id,
              occupancy: rate.occupancy,
              weekday_cents: rate.weekday_cents,
              weekend_cents: rate.weekend_cents,
            })),
        }));
      },
    );

    typed.patch(
      '/panel/room-rates/:id',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          body: roomRatePatchSchema,
          response: { 200: roomRateRowSchema, 404: errorResponseSchema },
        },
      },
      async (request) => {
        const updated = await db
          .updateTable('room_rates')
          .set(request.body)
          .where('id', '=', request.params.id)
          .returning(['id', 'room_id', 'occupancy', 'weekday_cents', 'weekend_cents'])
          .executeTakeFirst();

        if (!updated) {
          throw httpError(404, 'Room rate not found');
        }

        // 7th ARI push trigger (SPEC-modulo-12C § 3.2 extension, Channex
        // certification Stage 1): a base rate has no date of its own, so
        // push the WHOLE sync horizon for just this room — same single
        // "2-calls-total" push resyncAvailability.ts makes, scoped to one
        // room instead of every mapped room. Fire-and-forget, after commit.
        const checkIn = todayISO();
        const checkOut = formatDateUTC(addDaysUTC(parseDateUTC(checkIn), RESYNC_HORIZON_DAYS));
        schedulePushAvailability(db, [{ roomId: updated.room_id, checkIn, checkOut }]);

        const { room_id: _roomId, ...row } = updated;
        return row;
      },
    );
  });
};

export default panelRoomRatesPlugin;
