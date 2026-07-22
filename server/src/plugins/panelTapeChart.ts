import type { FastifyError, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { requireAuth } from '../auth/requireAuth.js';
import { getTapeChart, InvalidTapeChartRangeError } from '../panel/tapeChartQuery.js';
import { getReservationDetail } from '../panel/reservationDetailQuery.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const tapeChartQuerySchema = z.object({ from: dateSchema, to: dateSchema });

const tapeChartUnitSchema = z.object({
  id: z.number(),
  label: z.string(),
  room_type: z.string(),
  capacity: z.number(),
  sort_order: z.number(),
});

const tapeChartNightSchema = z.object({
  night: z.string(),
  room_unit_id: z.number(),
  reservation_id: z.number(),
  code: z.string().nullable(),
  guest_name: z.string().nullable(),
  has_balance_due: z.boolean(),
  is_first_night: z.boolean(),
  is_last_night: z.boolean(),
  is_fragmented: z.boolean(),
  fragment_group: z.number().nullable(),
});

const tapeChartResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  units: z.array(tapeChartUnitSchema),
  nights: z.array(tapeChartNightSchema),
  summary: z.object({
    arrivals_today: z.number(),
    departures_today: z.number(),
    occupied_today: z.number(),
    total_units: z.number(),
  }),
});

const reservationDetailResponseSchema = z.object({
  id: z.number(),
  code: z.string().nullable(),
  status: z.string(),
  arrival: z.string(),
  departure: z.string(),
  nights: z.number(),
  room_type: z.object({ id: z.number(), name: z.string() }),
  units: z.array(z.object({ night: z.string(), unit_label: z.string() })),
  guests: z.object({
    adults: z.number(),
    children: z.number(),
    children_ages: z.array(z.number()),
    babies: z.number(),
    total: z.number(),
  }),
  money: z.object({
    total_cents: z.number(),
    deposit_cents: z.number().nullable(),
    paid_cents: z.number(),
    balance_cents: z.number(),
  }),
  origin: z.string(),
  contact: z.object({ name: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() }),
  comments: z.string().nullable(),
  created_at: z.string(),
});

const errorResponseSchema = z.object({ error: z.string() });

function httpError(statusCode: number, message: string): FastifyError {
  const err = new Error(message) as FastifyError;
  err.statusCode = statusCode;
  err.code = 'PANEL_TAPE_CHART_ERROR';
  err.name = 'PanelTapeChartError';
  return err;
}

export interface PanelTapeChartPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const panelTapeChartPlugin: FastifyPluginAsync<PanelTapeChartPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  await fastify.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', requireAuth(db));
    const typed = protectedScope.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/panel/tape-chart',
      {
        schema: {
          querystring: tapeChartQuerySchema,
          response: { 200: tapeChartResponseSchema, 400: errorResponseSchema },
        },
      },
      async (request) => {
        const { from, to } = request.query;

        try {
          return await getTapeChart(db, from, to);
        } catch (err) {
          if (err instanceof InvalidTapeChartRangeError) {
            throw httpError(400, err.message);
          }
          throw err;
        }
      },
    );

    typed.get(
      '/panel/reservations/:id',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          response: { 200: reservationDetailResponseSchema, 404: errorResponseSchema },
        },
      },
      async (request) => {
        const detail = await getReservationDetail(db, request.params.id);
        if (!detail) {
          throw httpError(404, 'Reservation not found');
        }
        return detail;
      },
    );
  });
};

export default panelTapeChartPlugin;
