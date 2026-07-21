import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { db } from '../db/client.js';
import { fetchRoomStayData } from '../availability/repository.js';
import { calculateAvailability } from '../availability/calculateAvailability.js';
import { calculatePrice } from '../pricing/calculatePrice.js';

const MAX_NIGHTS = 60;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const querySchema = z
  .object({
    check_in: dateSchema,
    check_out: dateSchema,
    guests: z.coerce.number().int().min(1),
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
      available: z.boolean(),
      units_left: z.number(),
      total_units: z.number(),
      total_cents: z.number().nullable(),
      min_stay_ok: z.boolean(),
    }),
  ),
});

const availabilityPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/availability',
    { schema: { querystring: querySchema, response: { 200: responseSchema } } },
    async (request) => {
      const { check_in, check_out, guests } = request.query;

      const activeRooms = await db
        .selectFrom('rooms')
        .select('id')
        .where('active', '=', true)
        .where('capacity', '>=', guests)
        .orderBy('id')
        .execute();

      const rooms = [];
      for (const { id } of activeRooms) {
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
