import type { FastifyError, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { requireAuth } from '../auth/requireAuth.js';
import { blockIfMustChangePassword } from '../auth/blockIfMustChangePassword.js';
import { requirePermission } from '../auth/requirePermission.js';
import { getChannexConfig, updateChannexConfig } from '../channex/channexConfig.js';
import { ChannexApiError, ChannexNotConfiguredError, getProperty, listRoomTypes } from '../channex/channexClient.js';
import { getMappingStatus, listLocalRoomsWithMapping, setRoomTypeMap } from '../channex/channexRoomTypeMap.js';
import { isChannexRoomTypeUniqueViolation } from '../channex/isChannexRoomTypeUniqueViolation.js';
import { pullBookingRevisions } from '../channex/pullBookingRevisions.js';
import { resyncAvailability } from '../channex/resyncAvailability.js';
import { retryOtaConflict, listOtaConflicts, ReservationNotFoundError, ReservationNotInConflictError } from '../panel/otaConflicts.js';

const channexConfigResponseSchema = z.object({
  connected: z.boolean(),
  environment: z.enum(['staging', 'production']),
  property_id: z.string().uuid().nullable(),
  is_active: z.boolean(),
});

// `environment` is intentionally absent here — see channexConfig.ts's
// ChannexConfigRecord comment on why it's read-only, derived from
// CHANNEX_ENV, never PATCH-able.
const channexConfigPatchSchema = z.object({
  property_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().optional(),
});

const testConnectionResponseSchema = z.object({
  ok: z.boolean(),
  property: z.object({ id: z.string(), title: z.string().optional() }).optional(),
  error: z.string().optional(),
});

const roomTypesResponseSchema = z.object({
  local_rooms: z.array(
    z.object({
      room_id: z.number(),
      room_name: z.string(),
      channex_room_type_id: z.string().uuid().nullable(),
      channex_rate_plan_id: z.string().uuid().nullable(),
    }),
  ),
  channex_room_types: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      count_of_rooms: z.number(),
    }),
  ),
});

const roomTypeMapPatchSchema = z.object({
  room_id: z.number().int().positive(),
  channex_room_type_id: z.string().uuid(),
  channex_rate_plan_id: z.string().uuid().nullable(),
});

const mappingStatusResponseSchema = z.object({
  complete: z.boolean(),
  total_rooms: z.number(),
  mapped_rooms: z.number(),
});

const pullNowResponseSchema = z.object({
  total_feed_items: z.number(),
  processed: z.number(),
  acked: z.number(),
});

const retryConflictResponseSchema = z.object({
  resolved: z.boolean(),
});

const resyncResponseSchema = z.object({
  rooms_pushed: z.number(),
  rooms_skipped: z.number(),
});

const conflictSummaryResponseSchema = z.object({
  id: z.number(),
  code: z.string().nullable(),
  room_name: z.string(),
  check_in: z.string(),
  check_out: z.string(),
  guests: z.number(),
  guest_name: z.string().nullable(),
  total_cents: z.number(),
});

const errorResponseSchema = z.object({ error: z.string() });

function httpError(statusCode: number, message: string): FastifyError {
  const err = new Error(message) as FastifyError;
  err.statusCode = statusCode;
  err.code = 'PANEL_CHANNEX_ERROR';
  err.name = 'PanelChannexError';
  return err;
}

function toResponse(record: { environment: 'staging' | 'production'; propertyId: string | null; isActive: boolean }) {
  return {
    connected: record.isActive && record.propertyId !== null,
    environment: record.environment,
    property_id: record.propertyId,
    is_active: record.isActive,
  };
}

export interface PanelChannexPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const panelChannexPlugin: FastifyPluginAsync<PanelChannexPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  await fastify.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', requireAuth(db));
    protectedScope.addHook('onRequest', blockIfMustChangePassword());
    protectedScope.addHook('onRequest', requirePermission(db, 'ota.manage'));
    const typed = protectedScope.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/panel/channex/config',
      { schema: { response: { 200: channexConfigResponseSchema } } },
      async () => toResponse(await getChannexConfig(db)),
    );

    typed.patch(
      '/panel/channex/config',
      {
        schema: {
          body: channexConfigPatchSchema,
          response: { 200: channexConfigResponseSchema },
        },
      },
      async (request) => {
        const updated = await updateChannexConfig(db, {
          propertyId: request.body.property_id,
          isActive: request.body.is_active,
        });
        return toResponse(updated);
      },
    );

    // Read-only (SPEC-modulo-12A § 5): only ever calls GET /properties/:id on
    // Channex, never writes. Errors are reduced to a status code — never the
    // Channex response body — before reaching the client (§ 8: the secret and
    // any of Channex's own error detail must not leak through this endpoint).
    typed.post(
      '/panel/channex/test-connection',
      { schema: { response: { 200: testConnectionResponseSchema } } },
      async () => {
        const current = await getChannexConfig(db);

        if (!current.propertyId) {
          return { ok: false, error: 'property_id não configurado' };
        }

        try {
          const property = await getProperty(current.propertyId);
          return {
            ok: true,
            property: { id: property.id, title: typeof property.title === 'string' ? property.title : undefined },
          };
        } catch (error) {
          if (error instanceof ChannexNotConfiguredError) {
            return { ok: false, error: 'Channex API key não configurada no servidor' };
          }
          if (error instanceof ChannexApiError) {
            return { ok: false, error: `Channex respondeu ${error.status}` };
          }
          throw error;
        }
      },
    );

    // Reads room types straight from Channex (SPEC § 5/§ 6 — the panel's
    // selector must offer real Channex room types, never a stale local
    // cache), merged with our current local mapping so the frontend can
    // render "mapeado / sin mapear" without a second round trip.
    typed.get(
      '/panel/channex/room-types',
      { schema: { response: { 200: roomTypesResponseSchema, 400: errorResponseSchema } } },
      async () => {
        const current = await getChannexConfig(db);

        if (!current.propertyId) {
          throw httpError(400, 'property_id não configurado');
        }

        const [localRooms, channexRoomTypes] = await Promise.all([
          listLocalRoomsWithMapping(db),
          listRoomTypes(current.propertyId),
        ]);

        return {
          local_rooms: localRooms.map((room) => ({
            room_id: room.roomId,
            room_name: room.roomName,
            channex_room_type_id: room.channexRoomTypeId,
            channex_rate_plan_id: room.channexRatePlanId,
          })),
          channex_room_types: channexRoomTypes.map((roomType) => ({
            id: roomType.id,
            title: roomType.title,
            count_of_rooms: roomType.count_of_rooms,
          })),
        };
      },
    );

    // Associates one local room to a Channex room type (+ optional rate
    // plan). 1:1 enforced by the DB's UNIQUE(channex_room_type_id) — a
    // second local room trying to claim the same Channex room type gets a
    // clean 409, not a raw Postgres error (§ 8: no orphans in the mapping).
    typed.put(
      '/panel/channex/room-type-map',
      { schema: { body: roomTypeMapPatchSchema, response: { 204: z.void(), 409: errorResponseSchema } } },
      async (request, reply) => {
        try {
          await setRoomTypeMap(db, {
            roomId: request.body.room_id,
            channexRoomTypeId: request.body.channex_room_type_id,
            channexRatePlanId: request.body.channex_rate_plan_id,
          });
        } catch (error) {
          if (isChannexRoomTypeUniqueViolation(error)) {
            reply.status(409).send({ error: 'Este Room Type do Channex já está associado a outro quarto' });
            return;
          }
          throw error;
        }

        reply.status(204).send();
      },
    );

    typed.get(
      '/panel/channex/mapping-status',
      { schema: { response: { 200: mappingStatusResponseSchema } } },
      async () => {
        const status = await getMappingStatus(db);
        return { complete: status.complete, total_rooms: status.totalRooms, mapped_rooms: status.mappedRooms };
      },
    );

    // § 3.4/§ 9: manual trigger for the pull — no cron until 12D. Reuses the
    // exact same processing function the webhook uses (§ 3.1).
    typed.post(
      '/panel/channex/pull-now',
      { schema: { response: { 200: pullNowResponseSchema, 400: errorResponseSchema } } },
      async () => {
        const current = await getChannexConfig(db);
        if (!current.propertyId) {
          throw httpError(400, 'property_id não configurado');
        }

        const result = await pullBookingRevisions(db, current.propertyId);
        return {
          total_feed_items: result.totalFeedItems,
          processed: result.items.length,
          acked: result.items.filter((item) => item.acked).length,
        };
      },
    );

    // SPEC-modulo-12C § 3.3/§ 6: manual full resync — pushes ARI for every
    // mapped room type across the whole 6-month horizon, correcting any
    // drift the fire-and-forget incremental push (§ 3.2) may have missed.
    typed.post(
      '/panel/channex/resync',
      { schema: { response: { 200: resyncResponseSchema } } },
      async () => {
        const result = await resyncAvailability(db);
        return { rooms_pushed: result.roomsPushed, rooms_skipped: result.roomsSkipped };
      },
    );

    // § 6: the tape chart has nowhere to render an ota_conflict reservation
    // (it's keyed off reservation_nights, which this status has none of) —
    // this is the actual listing an operator uses to see and act on them.
    typed.get(
      '/panel/channex/conflicts',
      { schema: { response: { 200: z.array(conflictSummaryResponseSchema) } } },
      async () => {
        const conflicts = await listOtaConflicts(db);
        return conflicts.map((c) => ({
          id: c.id,
          code: c.code,
          room_name: c.roomName,
          check_in: c.checkIn,
          check_out: c.checkOut,
          guests: c.guests,
          guest_name: c.guestName,
          total_cents: c.totalCents,
        }));
      },
    );

    // § 3.5: reassigns a unit for a reservation stuck in `ota_conflict`, if
    // one is free now. Same reassignment transaction the modification path
    // uses (channex/processBookingRevision.ts's reassignOtaReservation).
    typed.post(
      '/panel/channex/conflicts/:reservationId/retry',
      {
        schema: {
          params: z.object({ reservationId: z.coerce.number().int().positive() }),
          response: { 200: retryConflictResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
        },
      },
      async (request, reply) => {
        try {
          const result = await retryOtaConflict(db, request.params.reservationId);
          return result;
        } catch (error) {
          if (error instanceof ReservationNotFoundError) {
            reply.status(404).send({ error: 'reservation_not_found' });
            return;
          }
          if (error instanceof ReservationNotInConflictError) {
            reply.status(409).send({ error: `reservation_not_in_conflict: ${error.status}` });
            return;
          }
          throw error;
        }
      },
    );
  });
};

export default panelChannexPlugin;
