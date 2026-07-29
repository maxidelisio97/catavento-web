/**
 * GET /panel/rate-overrides, PUT /panel/rate-overrides,
 * PATCH /panel/rate-overrides/range — SPEC-modulo-8-configuracion.md § 6.2–6.5.
 */
import type { FastifyError, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { requireAuth } from '../auth/requireAuth.js';
import { parseDateUTC } from '../shared/dateUtils.js';
import {
  applyRateOverridesRange,
  listRateOverrides,
  putRateOverride,
  RoomNotFoundError,
  UnitsAvailableBelowOccupiedError,
} from '../panel/rateOverrides.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const rateOverrideRowSchema = z.object({
  date: z.string(),
  price_cents: z.number().nullable(),
  min_stay: z.number().nullable(),
  closed: z.boolean(),
  units_available: z.number().nullable(),
});

// `.nullable()` on top of `.optional()` on every field: absent = don't touch
// (§ 6.3 "campos opcionales"), explicit `null` = clear that field back to
// base. `closed` has no base-distinct "clear" state (see rateOverrides.ts's
// doc comment), so it stays a plain optional boolean.
const patchFieldsSchema = z.object({
  price_cents: z.number().int().min(0).nullable().optional(),
  min_stay: z.number().int().min(1).nullable().optional(),
  closed: z.boolean().optional(),
  units_available: z.number().int().min(0).nullable().optional(),
});

function hasAnyPatchField(body: Record<string, unknown>, excludeKeys: string[]): boolean {
  return Object.keys(body).some((key) => !excludeKeys.includes(key));
}

const listQuerySchema = z.object({
  room_id: z.coerce.number().int().positive(),
  from: dateSchema,
  to: dateSchema,
});

const putBodySchema = z
  .object({ room_id: z.number().int().positive(), date: dateSchema })
  .merge(patchFieldsSchema)
  .refine((body) => hasAnyPatchField(body, ['room_id', 'date']), {
    message: 'Body must include at least one field to override',
  });

// Risk-review finding (8C, pre-merge): applyRateOverridesRange holds
// `rooms` FOR UPDATE — the same lock createReservation serializes on — for
// the whole per-night write loop. An unbounded range turns a panel edit
// into a self-inflicted lock-out of that room's reservation flow for
// however long the batch takes. 400 nights (~13 months) comfortably covers
// any real use ("todo enero", "carnaval") while keeping the lock held for
// a bounded, short amount of time.
const MAX_RANGE_NIGHTS = 400;

function rangeNightsCount(from: string, to: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((parseDateUTC(to).getTime() - parseDateUTC(from).getTime()) / msPerDay) + 1;
}

const rangeBodySchema = z
  .object({ room_id: z.number().int().positive(), from: dateSchema, to: dateSchema })
  .merge(patchFieldsSchema)
  .refine((body) => body.to >= body.from, { message: 'to must be >= from' })
  .refine((body) => rangeNightsCount(body.from, body.to) <= MAX_RANGE_NIGHTS, {
    message: `Range cannot exceed ${MAX_RANGE_NIGHTS} nights`,
  })
  .refine((body) => hasAnyPatchField(body, ['room_id', 'from', 'to']), {
    message: 'Body must include at least one field to override',
  });

const rangeResultSchema = z.object({
  nights: z.number(),
  price_min_stay_closed_applied: z.boolean(),
  units_available: z
    .object({
      applied_count: z.number(),
      failures: z.array(z.object({ date: z.string(), occupied: z.number() })),
    })
    .nullable(),
});

const errorResponseSchema = z.object({ error: z.string() });

const unitsAvailableConflictSchema = z.object({
  error: z.literal('UNITS_AVAILABLE_BELOW_OCCUPIED'),
  date: z.string(),
  occupied: z.number(),
  requested: z.number(),
});

function httpError(statusCode: number, message: string): FastifyError {
  const err = new Error(message) as FastifyError;
  err.statusCode = statusCode;
  err.code = 'PANEL_RATE_OVERRIDES_ERROR';
  err.name = 'PanelRateOverridesError';
  return err;
}

export interface PanelRateOverridesPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const panelRateOverridesPlugin: FastifyPluginAsync<PanelRateOverridesPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  await fastify.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', requireAuth(db));
    const typed = protectedScope.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/panel/rate-overrides',
      {
        schema: {
          querystring: listQuerySchema,
          response: { 200: z.array(rateOverrideRowSchema) },
        },
      },
      async (request) => {
        const { room_id, from, to } = request.query;
        return listRateOverrides(db, { roomId: room_id, from, to });
      },
    );

    typed.put(
      '/panel/rate-overrides',
      {
        schema: {
          body: putBodySchema,
          response: {
            200: rateOverrideRowSchema,
            404: errorResponseSchema,
            409: unitsAvailableConflictSchema,
          },
        },
      },
      async (request, reply) => {
        const { room_id, date, ...patch } = request.body;

        try {
          const row = await putRateOverride(db, { roomId: room_id, date, ...patch });
          return row;
        } catch (err) {
          if (err instanceof RoomNotFoundError) throw httpError(404, 'ROOM_NOT_FOUND');
          if (err instanceof UnitsAvailableBelowOccupiedError) {
            reply.status(409);
            return {
              error: 'UNITS_AVAILABLE_BELOW_OCCUPIED' as const,
              date: err.date,
              occupied: err.occupied,
              requested: err.requested,
            };
          }
          throw err;
        }
      },
    );

    typed.patch(
      '/panel/rate-overrides/range',
      {
        schema: {
          body: rangeBodySchema,
          response: { 200: rangeResultSchema, 404: errorResponseSchema },
        },
      },
      async (request) => {
        const { room_id, from, to, ...patch } = request.body;

        try {
          const result = await applyRateOverridesRange(db, { roomId: room_id, from, to, ...patch });
          return {
            nights: result.nights,
            price_min_stay_closed_applied: result.priceMinStayClosedApplied,
            units_available: result.unitsAvailable
              ? { applied_count: result.unitsAvailable.appliedCount, failures: result.unitsAvailable.failures }
              : null,
          };
        } catch (err) {
          if (err instanceof RoomNotFoundError) throw httpError(404, 'ROOM_NOT_FOUND');
          throw err;
        }
      },
    );
  });
};

export default panelRateOverridesPlugin;
