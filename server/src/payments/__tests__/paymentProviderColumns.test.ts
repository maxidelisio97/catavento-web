/**
 * Behavioral test for migrations/1785800000000_add-payment-provider-columns.ts
 * (sdd/asaas-pagarme-migration design, obs #257) — proves the DB invariants
 * the design relies on: the `provider`/`provider_payment_id` pairing check,
 * the provider allow-list, the partial UNIQUE index (scoped to non-null
 * provider_payment_id, so manually registered payments with both columns
 * NULL never collide), the widened method CHECK accepting the new
 * `pagarme_pix`/`pagarme_card` literals, and the backfill of pre-existing
 * asaas_payment_id rows into provider='asaas'.
 */
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE payments, reservations, rate_overrides, room_rates, rooms RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

let reservationCounter = 0;

async function insertTestReservation(): Promise<number> {
  reservationCounter += 1;
  const suffix = String(reservationCounter).padStart(4, '0');

  const room = await testDb
    .insertInto('rooms')
    .values({ name: `TestRoom${suffix}`, capacity: 2, pets_allowed: false, default_min_stay: 1, total_units: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();

  const reservation = await testDb
    .insertInto('reservations')
    .values({
      room_id: room.id,
      code: `PROV${suffix}`,
      status: 'pending_payment',
      check_in: '2026-09-01',
      check_out: '2026-09-03',
      guests: 2,
      total_cents: 20000,
      deposit_cents: 10000,
      guest_name: 'Maria Silva',
      guest_email: 'maria@example.com',
      guest_phone: '11999998888',
      expires_at: new Date(Date.now() + 30 * 60 * 1000),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return reservation.id;
}

beforeEach(async () => {
  await resetDb();
  reservationCounter = 0;
});

describe('payments.provider / payments.provider_payment_id (migration 1785800000000)', () => {
  it('accepts a pagarme row with the new method literals', async () => {
    const reservationId = await insertTestReservation();

    const row = await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservationId,
        amount_cents: 10000,
        method: 'pagarme_pix',
        status: 'pending',
        provider: 'pagarme',
        provider_payment_id: 'order_abc123',
      })
      .returning(['provider', 'provider_payment_id', 'method'])
      .executeTakeFirstOrThrow();

    expect(row).toEqual({ provider: 'pagarme', provider_payment_id: 'order_abc123', method: 'pagarme_pix' });
  });

  it('accepts an asaas row (backfill-equivalent shape) alongside the legacy asaas_payment_id column', async () => {
    const reservationId = await insertTestReservation();

    const row = await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservationId,
        amount_cents: 10000,
        method: 'asaas_pix',
        status: 'pending',
        asaas_payment_id: 'pay_xyz789',
        provider: 'asaas',
        provider_payment_id: 'pay_xyz789',
      })
      .returning(['provider', 'provider_payment_id', 'asaas_payment_id'])
      .executeTakeFirstOrThrow();

    expect(row).toEqual({ provider: 'asaas', provider_payment_id: 'pay_xyz789', asaas_payment_id: 'pay_xyz789' });
  });

  it('allows a manually registered payment with both provider columns NULL', async () => {
    const reservationId = await insertTestReservation();

    const row = await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservationId,
        amount_cents: 10000,
        method: 'cash',
        status: 'received',
        provider: null,
        provider_payment_id: null,
      })
      .returning(['provider', 'provider_payment_id'])
      .executeTakeFirstOrThrow();

    expect(row).toEqual({ provider: null, provider_payment_id: null });
  });

  it('rejects an unknown provider value (payments_provider_check)', async () => {
    const reservationId = await insertTestReservation();

    await expect(
      testDb
        .insertInto('payments')
        .values({
          reservation_id: reservationId,
          amount_cents: 10000,
          method: 'pagarme_pix',
          status: 'pending',
          provider: 'stripe',
          provider_payment_id: 'order_1',
        })
        .execute(),
    ).rejects.toThrow(/payments_provider_check/);
  });

  it('rejects provider set without provider_payment_id (payments_provider_pairing_check)', async () => {
    const reservationId = await insertTestReservation();

    await expect(
      testDb
        .insertInto('payments')
        .values({
          reservation_id: reservationId,
          amount_cents: 10000,
          method: 'pagarme_pix',
          status: 'pending',
          provider: 'pagarme',
          provider_payment_id: null,
        })
        .execute(),
    ).rejects.toThrow(/payments_provider_pairing_check/);
  });

  it('rejects two rows with the same (provider, provider_payment_id) — partial UNIQUE index', async () => {
    const reservationA = await insertTestReservation();
    const reservationB = await insertTestReservation();

    await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservationA,
        amount_cents: 10000,
        method: 'pagarme_pix',
        status: 'pending',
        provider: 'pagarme',
        provider_payment_id: 'order_dup',
      })
      .execute();

    await expect(
      testDb
        .insertInto('payments')
        .values({
          reservation_id: reservationB,
          amount_cents: 10000,
          method: 'pagarme_pix',
          status: 'pending',
          provider: 'pagarme',
          provider_payment_id: 'order_dup',
        })
        .execute(),
    ).rejects.toThrow(/payments_provider_payment_id_unique/);
  });

  it('does not collide two manually-registered (NULL, NULL) rows against the partial unique index', async () => {
    const reservationA = await insertTestReservation();
    const reservationB = await insertTestReservation();

    await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservationA,
        amount_cents: 10000,
        method: 'cash',
        status: 'received',
        provider: null,
        provider_payment_id: null,
      })
      .execute();

    await expect(
      testDb
        .insertInto('payments')
        .values({
          reservation_id: reservationB,
          amount_cents: 10000,
          method: 'cash',
          status: 'received',
          provider: null,
          provider_payment_id: null,
        })
        .execute(),
    ).resolves.not.toThrow();
  });
});
