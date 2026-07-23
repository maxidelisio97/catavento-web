import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { processPaymentReceived } from '../confirmPendingReservation.js';
import { createReservation } from '../createReservation.js';

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE reservation_nights, reservations, rate_overrides, room_rates, rooms RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

interface RoomFixtureOptions {
  totalUnits?: number;
}

async function insertTestRoom(options: RoomFixtureOptions = {}): Promise<number> {
  const totalUnits = options.totalUnits ?? 1;
  const room = await testDb
    .insertInto('rooms')
    .values({
      name: 'TestRoom',
      capacity: 2,
      pets_allowed: false,
      default_min_stay: 1,
      total_units: totalUnits,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  // Módulo 5: totalUnits is now derived from active room_units, not the
  // rooms.total_units column — create matching physical units so this
  // module's aggregate-only re-check keeps its exact original behavior.
  if (totalUnits > 0) {
    await testDb
      .insertInto('room_units')
      .values(
        Array.from({ length: totalUnits }, (_, i) => ({
          room_id: room.id,
          label: `${room.id}-${i + 1}`,
        })),
      )
      .execute();
  }

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

async function insertPayment(
  reservationId: number,
  asaasPaymentId: string,
  status = 'pending',
  kind = 'deposit',
): Promise<number> {
  const payment = await testDb
    .insertInto('payments')
    .values({
      reservation_id: reservationId,
      asaas_payment_id: asaasPaymentId,
      method: 'asaas_pix',
      amount_cents: 10000,
      status,
      kind,
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

  it('moves to payment_conflict (never confirmed with zero rows) when a late webhook arrives after a concurrent createReservation already swept the expired hold\'s reservation_nights', async () => {
    const roomId = await insertTestRoom({ totalUnits: 1 });
    // createReservation (unlike this file's insertReservation fixture) prices
    // the stay, which needs a matching room_rates row.
    await testDb
      .insertInto('room_rates')
      .values({ room_id: roomId, occupancy: 2, weekday_cents: 10000, weekend_cents: 15000 })
      .execute();

    // The stale hold: created through createReservation (módulo 6A — one
    // reservation_nights row per night) but already expired.
    const stale = await createReservation(testDb, {
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-03',
      guests: 2,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await insertPayment(stale.id, 'pay_race');

    const staleNightsBeforeSweep = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', stale.id)
      .execute();
    expect(staleNightsBeforeSweep).toHaveLength(2);

    // The lazy sweep in action: a new reservation for the same room/nights
    // finds the stale hold inactive, sweeps its reservation_nights, and
    // takes the only unit for itself — exactly what would happen if a guest
    // booked the room while the first guest's Asaas webhook was still in
    // flight.
    const winner = await createReservation(testDb, {
      roomId,
      checkIn: '2026-09-01',
      checkOut: '2026-09-03',
      guests: 2,
    });

    const staleNightsAfterSweep = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', stale.id)
      .execute();
    expect(staleNightsAfterSweep).toHaveLength(0);

    // The stale hold's late webhook finally arrives.
    const outcome = await processPaymentReceived(testDb, {
      asaasPaymentId: 'pay_race',
      rawEvent: { event: 'PAYMENT_RECEIVED' },
    });

    expect(outcome).toEqual({ kind: 'payment_conflict', reservationId: stale.id });

    const staleReservation = await testDb
      .selectFrom('reservations')
      .select('status')
      .where('id', '=', stale.id)
      .executeTakeFirstOrThrow();
    expect(staleReservation.status).toBe('payment_conflict');

    // Never confirmed with zero (or any mismatched count of) rows — the
    // whole point of this test.
    const staleNightsAfterWebhook = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', stale.id)
      .execute();
    expect(staleNightsAfterWebhook).toHaveLength(0);

    // The winner's reservation_nights are untouched by the conflict.
    const winnerNights = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', winner.id)
      .execute();
    expect(winnerNights).toHaveLength(2);
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

  it('SPEC-modulo-7 § 5.2: a balance payment on an already-confirmed reservation is recorded but never re-triggers confirmation', async () => {
    const roomId = await insertTestRoom({ totalUnits: 1 });
    const reservationId = await insertReservation({ roomId, status: 'confirmed' });
    await insertPayment(reservationId, 'pay_balance_1', 'pending', 'balance');

    const before = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', reservationId)
      .execute();

    const outcome = await processPaymentReceived(testDb, {
      asaasPaymentId: 'pay_balance_1',
      rawEvent: { event: 'PAYMENT_RECEIVED' },
    });

    expect(outcome).toEqual({
      kind: 'payment_marked_received_only',
      reservationId,
      reservationStatus: 'confirmed',
    });

    const payment = await testDb
      .selectFrom('payments')
      .select(['status', 'kind'])
      .where('reservation_id', '=', reservationId)
      .executeTakeFirstOrThrow();
    expect(payment.status).toBe('received');
    expect(payment.kind).toBe('balance');

    // The reservation stays confirmed — not re-confirmed, not touched — and
    // its reservation_nights are exactly as before (no reinsert/no wipe from
    // the confirm-room codepath, which a `deposit` payment WOULD trigger).
    const reservation = await testDb
      .selectFrom('reservations')
      .select('status')
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();
    expect(reservation.status).toBe('confirmed');

    const after = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', reservationId)
      .execute();
    expect(after).toEqual(before);
  });

  it('is idempotent for a balance payment: processing the same webhook twice only marks it received once, no double side effects', async () => {
    const roomId = await insertTestRoom({ totalUnits: 1 });
    const reservationId = await insertReservation({ roomId, status: 'confirmed' });
    await insertPayment(reservationId, 'pay_balance_2', 'pending', 'balance');

    const first = await processPaymentReceived(testDb, {
      asaasPaymentId: 'pay_balance_2',
      rawEvent: { event: 'PAYMENT_RECEIVED' },
    });
    const second = await processPaymentReceived(testDb, {
      asaasPaymentId: 'pay_balance_2',
      rawEvent: { event: 'PAYMENT_RECEIVED' },
    });

    expect(first).toEqual({
      kind: 'payment_marked_received_only',
      reservationId,
      reservationStatus: 'confirmed',
    });
    expect(second).toEqual({ kind: 'noop_idempotent' });
  });
});
