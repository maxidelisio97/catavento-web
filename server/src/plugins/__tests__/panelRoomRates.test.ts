/**
 * Integration tests for SPEC-modulo-8-configuracion.md § 5.2 — GET/PATCH
 * /panel/room-rates.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { sql } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelRoomRatesPlugin from '../panelRoomRates.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';

function buildApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelRoomRatesPlugin, { db: testDb });
  registerErrorHandler(app);
  return app;
}

async function insertSessionCookie(): Promise<string> {
  const user = await testDb
    .insertInto('users')
    .values({ email: 'owner@catavento.test', name: 'Maxi', password_hash: await hashPassword('whatever') })
    .returning('id')
    .executeTakeFirstOrThrow();

  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await testDb
    .insertInto('sessions')
    .values({ user_id: user.id, token_hash: tokenHash, expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) })
    .execute();

  return token;
}

async function insertTestRoom(name: string, sortOrder: number): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({
      name,
      capacity: 2,
      pets_allowed: false,
      adults_only: false,
      default_min_stay: 1,
      sort_order: sortOrder,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return room.id;
}

beforeEach(async () => {
  await sql`TRUNCATE TABLE reservations, rate_overrides, room_rates, rooms, users, sessions RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
});

afterEach(async () => {
  await sql`TRUNCATE TABLE reservations, rate_overrides, room_rates, rooms, users, sessions RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
});

describe('GET /panel/room-rates', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/panel/room-rates' });
    expect(response.statusCode).toBe(401);
  });

  it('returns rows grouped by room, ordered by rooms.sort_order', async () => {
    const token = await insertSessionCookie();
    const triploId = await insertTestRoom('Triplo', 2);
    const casalId = await insertTestRoom('Casal', 1);

    await testDb
      .insertInto('room_rates')
      .values([
        { room_id: triploId, occupancy: 2, weekday_cents: 20000, weekend_cents: 25000 },
        { room_id: triploId, occupancy: 3, weekday_cents: 24000, weekend_cents: 29000 },
        { room_id: casalId, occupancy: 2, weekday_cents: 18000, weekend_cents: 22000 },
      ])
      .execute();

    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/room-rates',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(2);
    expect(body[0].room_name).toBe('Casal');
    expect(body[0].rates).toEqual([
      { id: expect.any(Number), occupancy: 2, weekday_cents: 18000, weekend_cents: 22000 },
    ]);
    expect(body[1].room_name).toBe('Triplo');
    expect(body[1].rates).toEqual([
      { id: expect.any(Number), occupancy: 2, weekday_cents: 20000, weekend_cents: 25000 },
      { id: expect.any(Number), occupancy: 3, weekday_cents: 24000, weekend_cents: 29000 },
    ]);
  });
});

describe('PATCH /panel/room-rates/:id', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'PATCH', url: '/panel/room-rates/1', payload: { weekday_cents: 1 } });
    expect(response.statusCode).toBe(401);
  });

  it('updates only the fields sent, leaving the other price untouched', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertTestRoom('Casal', 1);
    const rate = await testDb
      .insertInto('room_rates')
      .values({ room_id: roomId, occupancy: 2, weekday_cents: 18000, weekend_cents: 22000 })
      .returning('id')
      .executeTakeFirstOrThrow();

    const app = buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: `/panel/room-rates/${rate.id}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { weekday_cents: 19000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: rate.id, occupancy: 2, weekday_cents: 19000, weekend_cents: 22000 });
  });

  it('rejects a negative price', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertTestRoom('Casal', 1);
    const rate = await testDb
      .insertInto('room_rates')
      .values({ room_id: roomId, occupancy: 2, weekday_cents: 18000, weekend_cents: 22000 })
      .returning('id')
      .executeTakeFirstOrThrow();

    const app = buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: `/panel/room-rates/${rate.id}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { weekday_cents: -100 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('accepts a price of 0', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertTestRoom('Casal', 1);
    const rate = await testDb
      .insertInto('room_rates')
      .values({ room_id: roomId, occupancy: 2, weekday_cents: 18000, weekend_cents: 22000 })
      .returning('id')
      .executeTakeFirstOrThrow();

    const app = buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: `/panel/room-rates/${rate.id}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { weekday_cents: 0 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().weekday_cents).toBe(0);
  });

  it('404s for a non-existent row', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/room-rates/999999',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { weekday_cents: 100 },
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects an empty body', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertTestRoom('Casal', 1);
    const rate = await testDb
      .insertInto('room_rates')
      .values({ room_id: roomId, occupancy: 2, weekday_cents: 18000, weekend_cents: 22000 })
      .returning('id')
      .executeTakeFirstOrThrow();

    const app = buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: `/panel/room-rates/${rate.id}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });
});
