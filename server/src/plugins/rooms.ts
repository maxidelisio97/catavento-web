import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { db } from '../db/client.js';

const roomRateSchema = z.object({
  occupancy: z.number().int(),
  weekdayCents: z.number().int(),
  weekendCents: z.number().int(),
});

const roomSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  capacity: z.number().int(),
  petsAllowed: z.boolean(),
  defaultMinStay: z.number().int(),
  rates: z.array(roomRateSchema),
});

const roomsPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/rooms',
    { schema: { response: { 200: z.array(roomSchema) } } },
    async () => {
      const rooms = await db
        .selectFrom('rooms')
        .select(['id', 'name', 'capacity', 'pets_allowed', 'default_min_stay'])
        .where('active', '=', true)
        .orderBy('id')
        .execute();

      const rates = await db
        .selectFrom('room_rates')
        .select(['room_id', 'occupancy', 'weekday_cents', 'weekend_cents'])
        .execute();

      return rooms.map((room) => ({
        id: room.id,
        name: room.name,
        capacity: room.capacity,
        petsAllowed: room.pets_allowed,
        defaultMinStay: room.default_min_stay,
        rates: rates
          .filter((rate) => rate.room_id === room.id)
          .map((rate) => ({
            occupancy: rate.occupancy,
            weekdayCents: rate.weekday_cents,
            weekendCents: rate.weekend_cents,
          })),
      }));
    },
  );
};

export default roomsPlugin;
