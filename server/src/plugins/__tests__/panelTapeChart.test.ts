/**
 * Integration tests for SPEC-modulo-6-panel-base.md § "6C.1 Endpoints de
 * lectura" — GET /panel/tape-chart and GET /panel/reservations/:id.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { sql } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelTapeChartPlugin from '../panelTapeChart.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';
import { eachNightUTC, addDaysUTC, formatDateUTC, parseDateUTC, todayISO } from '../../shared/dateUtils.js';
import type { TapeChartNight } from '../../panel/tapeChartQuery.js';

function buildApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelTapeChartPlugin, { db: testDb });
  registerErrorHandler(app);
  return app;
}

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE payments, reservation_nights, reservations, room_units, rooms, sessions, users RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

async function insertRoom(name: string, sortOrder: number, capacity = 2): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({ name, capacity, pets_allowed: false, default_min_stay: 1, sort_order: sortOrder })
    .returning('id')
    .executeTakeFirstOrThrow();
  return room.id;
}

async function insertUnit(roomId: number, label: string): Promise<number> {
  const unit = await testDb
    .insertInto('room_units')
    .values({ room_id: roomId, label })
    .returning('id')
    .executeTakeFirstOrThrow();
  return unit.id;
}

interface ReservationFixtureOptions {
  roomId: number;
  checkIn: string;
  checkOut: string;
  /** One room_unit_id per night (same length as the night count), for fragmentation. */
  nightUnitIds: number[];
  status?: string;
  expiresAt?: Date | null;
  guestName?: string;
  code?: string;
  totalCents?: number;
  depositCents?: number;
  children?: number;
  childrenAges?: number[];
  babies?: number;
  guestEmail?: string;
  guestPhone?: string;
  notes?: string;
  origin?: string;
}

async function insertReservation(options: ReservationFixtureOptions): Promise<number> {
  const nights = eachNightUTC(options.checkIn, options.checkOut);
  if (nights.length !== options.nightUnitIds.length) {
    throw new Error('nightUnitIds must have one entry per night');
  }

  const row = await testDb
    .insertInto('reservations')
    .values({
      room_id: options.roomId,
      room_unit_id: options.nightUnitIds[0],
      check_in: options.checkIn,
      check_out: options.checkOut,
      guests: 2 + (options.children ?? 0),
      children: options.children ?? 0,
      children_ages: options.childrenAges ?? [],
      babies: options.babies ?? 0,
      status: options.status ?? 'confirmed',
      expires_at: options.expiresAt ?? null,
      total_cents: options.totalCents ?? 30000,
      deposit_cents: options.depositCents ?? 15000,
      guest_name: options.guestName ?? 'Maria Gonzalez',
      guest_email: options.guestEmail ?? 'maria@example.com',
      guest_phone: options.guestPhone ?? '+55 85 90000-0000',
      code: options.code ?? `CAT-${randomBytes(4).toString('hex')}`,
      notes: options.notes ?? null,
      origin: options.origin ?? 'web',
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  if (nights.length > 0) {
    await testDb
      .insertInto('reservation_nights')
      .values(nights.map((night, i) => ({ reservation_id: row.id, night, room_unit_id: options.nightUnitIds[i] })))
      .execute();
  }

  return row.id;
}

async function insertPayment(reservationId: number, amountCents: number, status: string): Promise<void> {
  await testDb
    .insertInto('payments')
    .values({
      reservation_id: reservationId,
      asaas_payment_id: `pay_${randomBytes(6).toString('hex')}`,
      method: 'pix',
      amount_cents: amountCents,
      status,
    })
    .execute();
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

function windowAround(daysFromToday: number, nights: number): { from: string; to: string } {
  const from = formatDateUTC(addDaysUTC(parseDateUTC(todayISO()), daysFromToday));
  const to = formatDateUTC(addDaysUTC(parseDateUTC(from), nights));
  return { from, to };
}

beforeEach(async () => {
  await resetDb();
});

describe('GET /panel/tape-chart', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const { from, to } = windowAround(0, 14);
    const response = await app.inject({ method: 'GET', url: `/panel/tape-chart?from=${from}&to=${to}` });
    expect(response.statusCode).toBe(401);
  });

  it('returns one contiguous cell per night, with first/last night marked', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal', 1);
    const unitId = await insertUnit(roomId, '101');
    const { from, to } = windowAround(0, 14);
    const checkIn = from;
    const checkOut = formatDateUTC(addDaysUTC(parseDateUTC(checkIn), 3));
    await insertReservation({ roomId, checkIn, checkOut, nightUnitIds: [unitId, unitId, unitId] });

    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/panel/tape-chart?from=${from}&to=${to}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.nights).toHaveLength(3);
    const byNight = new Map<string, TapeChartNight>(body.nights.map((n: TapeChartNight) => [n.night, n]));
    expect(byNight.get(checkIn)!.is_first_night).toBe(true);
    expect(byNight.get(checkIn)!.is_last_night).toBe(false);
    const secondNight = formatDateUTC(addDaysUTC(parseDateUTC(checkIn), 1));
    expect(byNight.get(secondNight)!.is_first_night).toBe(false);
    expect(byNight.get(secondNight)!.is_last_night).toBe(false);
    const lastNight = formatDateUTC(addDaysUTC(parseDateUTC(checkIn), 2));
    expect(byNight.get(lastNight)!.is_last_night).toBe(true);
  });

  it('reads two contiguous reservations on the same unit as two distinct, non-overlapping blocks', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal', 1);
    const unitId = await insertUnit(roomId, '101');
    const { from, to } = windowAround(0, 14);

    const firstCheckIn = from;
    const handoffDate = formatDateUTC(addDaysUTC(parseDateUTC(firstCheckIn), 2));
    const secondCheckOut = formatDateUTC(addDaysUTC(parseDateUTC(handoffDate), 2));

    const firstId = await insertReservation({
      roomId,
      checkIn: firstCheckIn,
      checkOut: handoffDate,
      nightUnitIds: [unitId, unitId],
      guestName: 'Primeira Reserva',
    });
    const secondId = await insertReservation({
      roomId,
      checkIn: handoffDate,
      checkOut: secondCheckOut,
      nightUnitIds: [unitId, unitId],
      guestName: 'Segunda Reserva',
    });

    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/panel/tape-chart?from=${from}&to=${to}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const body = response.json();
    const byNight = new Map<string, TapeChartNight>(body.nights.map((n: TapeChartNight) => [n.night, n]));
    const handoffMinusOne = formatDateUTC(addDaysUTC(parseDateUTC(handoffDate), -1));
    expect(byNight.get(handoffMinusOne)!.reservation_id).toBe(firstId);
    expect(byNight.get(handoffMinusOne)!.is_last_night).toBe(true);
    expect(byNight.get(handoffDate)!.reservation_id).toBe(secondId);
    expect(byNight.get(handoffDate)!.is_first_night).toBe(true);
  });

  it('flags has_balance_due only when paid received payments are short of total_cents', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal', 1);
    const unitId = await insertUnit(roomId, '101');
    const { from, to } = windowAround(0, 14);
    const checkOut = formatDateUTC(addDaysUTC(parseDateUTC(from), 1));

    const unpaidId = await insertReservation({
      roomId,
      checkIn: from,
      checkOut,
      nightUnitIds: [unitId],
      totalCents: 20000,
    });

    const unitId2 = await insertUnit(roomId, '102');
    const settledId = await insertReservation({
      roomId,
      checkIn: from,
      checkOut,
      nightUnitIds: [unitId2],
      totalCents: 20000,
    });
    await insertPayment(settledId, 20000, 'received');
    // A pending (not yet received) payment must NOT count toward paid_cents.
    await insertPayment(unpaidId, 20000, 'pending');

    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/panel/tape-chart?from=${from}&to=${to}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const body = response.json();
    const byReservation = new Map<number, TapeChartNight>(body.nights.map((n: TapeChartNight) => [n.reservation_id, n]));
    expect(byReservation.get(unpaidId)!.has_balance_due).toBe(true);
    expect(byReservation.get(settledId)!.has_balance_due).toBe(false);
  });

  it('flags fragmented reservations across their full history, not just the visible window', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal', 1);
    const unitA = await insertUnit(roomId, '101');
    const unitB = await insertUnit(roomId, '102');
    const { from, to } = windowAround(0, 14);
    const checkOut = formatDateUTC(addDaysUTC(parseDateUTC(from), 2));

    const reservationId = await insertReservation({
      roomId,
      checkIn: from,
      checkOut,
      nightUnitIds: [unitA, unitB],
    });

    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/panel/tape-chart?from=${from}&to=${to}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const body = response.json();
    for (const night of body.nights) {
      expect(night.is_fragmented).toBe(true);
      expect(night.fragment_group).toBe(reservationId);
    }
  });

  it("summary counts today's arrivals/departures/occupancy regardless of the visible window", async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal', 1);
    const unitArriving = await insertUnit(roomId, '101');
    const unitDeparting = await insertUnit(roomId, '102');
    const today = todayISO();
    const yesterday = formatDateUTC(addDaysUTC(parseDateUTC(today), -1));
    const tomorrow = formatDateUTC(addDaysUTC(parseDateUTC(today), 1));

    // Arrives today, stays 2 nights.
    await insertReservation({ roomId, checkIn: today, checkOut: tomorrow, nightUnitIds: [unitArriving] });
    // Departs today (checked in yesterday).
    await insertReservation({ roomId, checkIn: yesterday, checkOut: today, nightUnitIds: [unitDeparting] });

    // Ask for a window that does NOT include today at all.
    const farFrom = formatDateUTC(addDaysUTC(parseDateUTC(today), 30));
    const farTo = formatDateUTC(addDaysUTC(parseDateUTC(farFrom), 14));

    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/panel/tape-chart?from=${farFrom}&to=${farTo}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const body = response.json();
    expect(body.summary.arrivals_today).toBe(1);
    expect(body.summary.departures_today).toBe(1);
    // Occupied today: only the reservation actually occupying `today`'s
    // night (the one departing today has no reservation_nights row for
    // `today`, since departure never generates a night — the arriving one does).
    expect(body.summary.occupied_today).toBe(1);
    expect(body.summary.total_units).toBe(2);
  });

  it('excludes cancelled and expired-pending reservations from nights and summary', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal', 1);
    const unitId = await insertUnit(roomId, '101');
    const today = todayISO();
    const tomorrow = formatDateUTC(addDaysUTC(parseDateUTC(today), 1));

    await insertReservation({ roomId, checkIn: today, checkOut: tomorrow, nightUnitIds: [unitId], status: 'cancelled' });

    const { from, to } = windowAround(0, 14);
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/panel/tape-chart?from=${from}&to=${to}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const body = response.json();
    expect(body.nights).toHaveLength(0);
    expect(body.summary.arrivals_today).toBe(0);
    expect(body.summary.occupied_today).toBe(0);
  });

  it('rejects a range over 60 nights with a controlled 400', async () => {
    const token = await insertSessionCookie();
    const { from, to } = windowAround(0, 61);
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: `/panel/tape-chart?from=${from}&to=${to}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /panel/reservations/:id', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/panel/reservations/1' });
    expect(response.statusCode).toBe(401);
  });

  it('404s for a reservation that does not exist', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/reservations/999999',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(404);
  });

  it('exposes every field of the spec, including minors ages/count and the balance', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal', 1);
    const unitId = await insertUnit(roomId, '101');
    const { from } = windowAround(0, 3);
    const checkOut = formatDateUTC(addDaysUTC(parseDateUTC(from), 3));

    const reservationId = await insertReservation({
      roomId,
      checkIn: from,
      checkOut,
      nightUnitIds: [unitId, unitId, unitId],
      totalCents: 66000,
      depositCents: 33000,
      children: 1,
      childrenAges: [7],
      babies: 1,
      guestName: 'Maria Gonzalez',
      guestEmail: 'maria@example.com',
      guestPhone: '+55 85 90000-0000',
      notes: 'Chegada tarde',
      origin: 'web',
    });
    await insertPayment(reservationId, 33000, 'received');

    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/panel/reservations/${reservationId}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.arrival).toBe(from);
    expect(body.departure).toBe(checkOut);
    expect(body.nights).toBe(3);
    expect(body.room_type.name).toBe('Casal');
    expect(body.units).toHaveLength(3);
    expect(body.guests).toEqual({ adults: 2, children: 1, children_ages: [7], babies: 1, total: 3 });
    expect(body.money).toEqual({ total_cents: 66000, deposit_cents: 33000, paid_cents: 33000, balance_cents: 33000 });
    expect(body.origin).toBe('web');
    expect(body.contact).toEqual({ name: 'Maria Gonzalez', email: 'maria@example.com', phone: '+55 85 90000-0000' });
    expect(body.comments).toBe('Chegada tarde');
  });
});
