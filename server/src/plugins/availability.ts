import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { fetchRoomStayData } from '../availability/repository.js';
import { calculateAvailability } from '../availability/calculateAvailability.js';
import { calculatePrice } from '../pricing/calculatePrice.js';

const MAX_NIGHTS = 60;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const querySchema = z
  .object({
    check_in: dateSchema,
    check_out: dateSchema,
    adults: z.coerce.number().int().min(1),
    children: z.coerce.number().int().min(0).default(0),
    babies: z.coerce.number().int().min(0).default(0),
  })
  .refine((q) => q.check_out > q.check_in, {
    message: 'check_out must be after check_in',
    path: ['check_out'],
  })
  .refine(
    (q) => {
      const nights = (Date.parse(q.check_out) - Date.parse(q.check_in)) / 86_400_000;
      return nights <= MAX_NIGHTS;
    },
    { message: `Range cannot exceed ${MAX_NIGHTS} nights`, path: ['check_out'] },
  );

const responseSchema = z.object({
  check_in: z.string(),
  check_out: z.string(),
  guests: z.number(),
  rooms: z.array(
    z.object({
      room_id: z.number(),
      name: z.string(),
      capacity: z.number(),
      adultsOnly: z.boolean(),
      available: z.boolean(),
      units_left: z.number(),
      total_units: z.number(),
      total_cents: z.number().nullable(),
      min_stay_ok: z.boolean(),
    }),
  ),
});

export interface AvailabilityPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const availabilityPlugin: FastifyPluginAsync<AvailabilityPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/availability',
    { schema: { querystring: querySchema, response: { 200: responseSchema } } },
    async (request) => {
      const { check_in, check_out, adults, children } = request.query;
      // `babies` is accepted for parity with POST /api/reservations and to
      // keep the querystring shape stable if a future rule needs it here,
      // but babies never affect capacity/guests — nothing else to derive
      // from it at this endpoint today.
      // Server derives `guests` itself — never trusts a client-supplied
      // total. Babies never count toward capacity, mirroring
      // POST /api/reservations.
      const guests = adults + children;

      // No capacity filter here on purpose: rooms that don't fit the party
      // must still come back (disabled downstream by the frontend using
      // `capacity`/`adultsOnly`), never silently disappear from the list.
      const activeRooms = await db
        .selectFrom('rooms')
        .select(['id', 'adults_only'])
        .where('active', '=', true)
        .orderBy('id')
        .execute();

      const rooms = [];
      for (const { id, adults_only } of activeRooms) {
        const stayData = await fetchRoomStayData(db, id, check_in, check_out);
        if (!stayData) continue;

        const availability = calculateAvailability({
          checkIn: check_in,
          checkOut: check_out,
          totalUnits: stayData.totalUnits,
          overrides: stayData.overrides,
          occupiedByDate: stayData.occupiedByDate,
        });

        const price = calculatePrice({
          checkIn: check_in,
          checkOut: check_out,
          guests,
          roomRates: stayData.roomRates,
          rateOverrides: stayData.overrides.map((o) => ({
            date: o.date,
            priceCents: o.priceCents,
            minStay: o.minStay,
            closed: o.closed,
          })),
          roomDefaultMinStay: stayData.defaultMinStay,
        });

        const minStayOk = price.status !== 'unavailable_min_stay';
        const totalCents = price.status === 'available' ? price.totalCents : null;

        rooms.push({
          room_id: stayData.roomId,
          name: stayData.name,
          capacity: stayData.capacity,
          adultsOnly: adults_only,
          available: availability.available && price.status === 'available',
          units_left: availability.unitsLeft,
          total_units: stayData.totalUnits,
          total_cents: totalCents,
          min_stay_ok: minStayOk,
        });
      }

      return { check_in, check_out, guests, rooms };
    },
  );
};

export default availabilityPlugin;
