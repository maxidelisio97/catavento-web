import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { processPaymentReceived } from '../confirmPendingReservation.js';

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE reservations, rate_overrides, room_rates, rooms RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

interface RoomFixtureOptions {
  totalUnits?: number;
}

async function insertTestRoom(options: RoomFixtureOptions = {}): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({
      name: 'TestRoom',
      capacity: 2,
      pets_allowed: false,
      default_min_stay: 1,
      total_units: options.totalUnits ?? 1,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return room.id;
}

interface ReservationFixtureOptions {
  roomId: number;
  status?: string;
  expiresAt?: Date | null;
  checkIn?: string;
  checkOut?: string;
}

async function insertReservation(options: ReservationFixtureOptions): Promise<number> {
  const reservation = await testDb
    .insertInto('reservations')
    .values({
      room_id: options.roomId,
      check_in: options.checkIn ?? '2026-09-01',
      check_out: options.checkOut ?? '2026-09-03',
      guests: 2,
      status: options.status ?? 'pending_payment',
      expires_at: options.expiresAt === undefined ? new Date(Date.now() + 30 * 60 * 1000) : options.expiresAt,
      total_cents: 20000,
      deposit_cents: 10000,
      code: 'TESTCODE',
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return reservation.id;
}

async function insertPayment(reservationId: number, asaasPaymentId: string, status = 'pending'): Promise<number> {
  const payment = await testDb
    .insertInto('payments')
    .values({
      reservation_id: reservationId,
      asaas_payment_id: asaasPaymentId,
      method: 'pix',
      amount_cents: 10000,
      status,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return payment.id;
}

beforeEach(async () => {
  await resetDb();
});

describe('processPaymentReceived', () => {
  it('returns unknown_payment when no local payment row matches', async () => {
    const outcome = await processPaymentReceived(testDb, {
      asaasPaymentId: 'does-not-exist',
      rawEvent: { event: 'PAYMENT_RECEIVED' },
    });

    expect(outcome).toEqual({ kind: 'unknown_payment' });
  });

  it('confirms a pending reservation and marks the payment received', async () => {
    const roomId = await insertTestRoom({ totalUnits: 1 });
    const reservationId = await insertReservation({ roomId });
    await insertPayment(reservationId, 'pay_1');

    const outcome = await processPaymentReceived(testDb, {
      asaasPaymentId: 'pay_1',
      rawEvent: { event: 'PAYMENT_RECEIVED' },
    });

    expect(outcome).toEqual({ kind: 'confirmed', reservationId });

    const reservation = await testDb
      .selectFrom('reservations')
      .select('status')
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();
    expect(reservation.status).toBe('confirmed');

    const payment = await testDb
      .selectFrom('payments')
      .select(['status', 'raw_last_event'])
      .where('reservation_id', '=', reservationId)
      .executeTakeFirstOrThrow();
    expect(payment.status).toBe('received');
    expect(payment.raw_last_event).not.toBeNull();
  });

  it('is idempotent: the same event processed twice only confirms once', async () => {
    const roomId = await insertTestRoom({ totalUnits: 1 });
    const reservationId = await insertReservation({ roomId });
    await insertPayment(reservationId, 'pay_2');

    const first = await processPaymentReceived(testDb, {
      asaasPaymentId: 'pay_2',
      rawEvent: { event: 'PAYMENT_RECEIVED' },
    });
    const second = await processPaymentReceived(testDb, {
      asaasPaymentId: 'pay_2',
      rawEvent: { event: 'PAYMENT_RECEIVED' },
    });

    expect(first).toEqual({ kind: 'confirmed', reservationId });
    expect(second).toEqual({ kind: 'noop_idempotent' });

    const reservation = await testDb
      .selectFrom('reservations')
      .select('status')
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();
    expect(reservation.status).toBe('confirmed');
  });

  it('confirms a reservation that already expired if the nights are still available (caso límite, con disponibilidad)', async () => {
    const roomId = await insertTestRoom({ totalUnits: 1 });
    const reservationId = await insertReservation({ roomId, expiresAt: new Date(Date.now() - 60_000) });
    await insertPayment(reservationId, 'pay_3');

    const outcome = await processPaymentReceived(testDb, {
      asaasPaymentId: 'pay_3',
      rawEvent: { event: 'PAYMENT_RECEIVED' },
    });

    expect(outcome).toEqual({ kind: 'confirmed', reservationId });
  });

  it('moves to payment_conflict when the room is no longer available after expiry (caso límite, sin disponibilidad), and never double-books the unit', async () => {
    const roomId = await insertTestRoom({ totalUnits: 1 });
    // The reservation we're about to confirm — already expired.
    const staleReservationId = await insertReservation({
      roomId,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await insertPayment(staleReservationId, 'pay_4');

    // Someone else grabbed the only unit for the same nights in the meantime.
    await testDb
      .insertInto('reservations')
      .values({
        room_id: roomId,
        check_in: '2026-09-01',
        check_out: '2026-09-03',
        guests: 2,
        status: 'confirmed',
        total_cents: 20000,
        code: 'OTHERONE',
      })
      .execute();

    const outcome = await processPaymentReceived(testDb, {
      asaasPaymentId: 'pay_4',
      rawEvent: { event: 'PAYMENT_RECEIVED' },
    });

    expect(outcome).toEqual({ kind: 'payment_conflict', reservationId: staleReservationId });

    const reservation = await testDb
      .selectFrom('reservations')
      .select('status')
      .where('id', '=', staleReservationId)
      .executeTakeFirstOrThrow();
    expect(reservation.status).toBe('payment_conflict');

    // The unit is not double-booked: exactly one active reservation for these nights.
    const activeCount = await testDb
      .selectFrom('reservations')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('room_id', '=', roomId)
      .where('status', 'in', ['confirmed', 'pending_payment'])
      .executeTakeFirstOrThrow();
    expect(Number(activeCount.count)).toBe(1);
  });

  it('marks the payment received without re-confirming a reservation already settled by another path', async () => {
    const roomId = await insertTestRoom({ totalUnits: 1 });
    const reservationId = await insertReservation({ roomId, status: 'cancelled' });
    await insertPayment(reservationId, 'pay_5');

    const outcome = await processPaymentReceived(testDb, {
      asaasPaymentId: 'pay_5',
      rawEvent: { event: 'PAYMENT_RECEIVED' },
    });

    expect(outcome).toEqual({
      kind: 'payment_marked_received_only',
      reservationId,
      reservationStatus: 'cancelled',
    });

    const payment = await testDb
      .selectFrom('payments')
      .select('status')
      .where('reservation_id', '=', reservationId)
      .executeTakeFirstOrThrow();
    expect(payment.status).toBe('received');

    const reservation = await testDb
      .selectFrom('reservations')
      .select('status')
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();
    expect(reservation.status).toBe('cancelled'); // untouched
  });
});
