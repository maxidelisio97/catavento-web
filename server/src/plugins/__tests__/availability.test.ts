import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { registerErrorHandler } from '../../errorHandler.js';
import availabilityPlugin from '../../plugins/availability.js';

function buildApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(availabilityPlugin, { prefix: '/api', db: testDb });
  registerErrorHandler(app);
  return app;
}

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE reservations, rate_overrides, room_rates, rooms RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

interface RoomFixtureOptions {
  name?: string;
  totalUnits?: number;
  capacity?: number;
  adultsOnly?: boolean;
}

async function insertTestRoom(options: RoomFixtureOptions = {}): Promise<number> {
  const capacity = options.capacity ?? 2;
  const room = await testDb
    .insertInto('rooms')
    .values({
      name: options.name ?? 'TestRoom',
      capacity,
      pets_allowed: false,
      adults_only: options.adultsOnly ?? false,
      default_min_stay: 1,
      total_units: options.totalUnits ?? 3,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await testDb
    .insertInto('room_rates')
    .values({ room_id: room.id, occupancy: capacity, weekday_cents: 10000, weekend_cents: 15000 })
    .execute();

  return room.id;
}

beforeEach(async () => {
  await resetDb();
});

describe('GET /api/availability', () => {
  it('never filters out a room that does not fit the party — it stays in the list with its real capacity', async () => {
    await insertTestRoom({ name: 'Casal', capacity: 2, adultsOnly: true });
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/availability?check_in=2026-09-01&check_out=2026-09-03&adults=4',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].capacity).toBe(2);
    expect(body.rooms[0].name).toBe('Casal');
  });

  it('exposes adultsOnly per room', async () => {
    await insertTestRoom({ name: 'Casal', capacity: 2, adultsOnly: true });
    await insertTestRoom({ name: 'Triplo', capacity: 3, adultsOnly: false });
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/availability?check_in=2026-09-01&check_out=2026-09-03&adults=2',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const byName = Object.fromEntries(body.rooms.map((r: { name: string; adultsOnly: boolean }) => [r.name, r.adultsOnly]));
    expect(byName.Casal).toBe(true);
    expect(byName.Triplo).toBe(false);
  });

  it('derives guests server-side as adults + children, ignoring any client-supplied guests', async () => {
    await insertTestRoom({ capacity: 4 });
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/availability?check_in=2026-09-01&check_out=2026-09-03&adults=2&children=1&babies=1&guests=99',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.guests).toBe(3); // 2 adults + 1 child — babies and the bogus guests=99 are ignored
  });

  it('rejects a missing adults param with 400', async () => {
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/availability?check_in=2026-09-01&check_out=2026-09-03',
    });

    expect(response.statusCode).toBe(400);
  });
});
