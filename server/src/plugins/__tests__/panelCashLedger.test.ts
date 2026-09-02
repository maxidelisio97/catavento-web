/**
 * Integration tests for GET /panel/cash/ledger — SPEC-modulo-10-caja.md § 3.
 *
 * This is the module's central risk (§ 1, § 9): the ledger must READ
 * `payments` + `cash_movements`, never copy one into the other. Every test
 * here either proves a payment shows up EXACTLY once (not zero, not two —
 * see "does not duplicate or drop"), proves the UTC day-boundary is exact
 * (the same class of bug M2 already found once), or proves the net
 * calculation is arithmetically correct including a refund.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelCashPlugin from '../panelCash.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { createRoleWithPermissions, createSessionCookieForRole } from '../../test-support/permissionFixtures.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';

function buildApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelCashPlugin, { db: testDb });
  registerErrorHandler(app);
  return app;
}

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE cash_movements, cash_expense_categories, cash_sale_items, payments, reservations, rooms, sessions, user_permission_overrides, users RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

beforeEach(resetDb);

async function tokenWithCashView(): Promise<string> {
  const roleId = await createRoleWithPermissions(testDb, ['cash.view']);
  return createSessionCookieForRole(testDb, roleId);
}

/** A user to attribute fixture data to — distinct from the session user, doesn't need a session. */
async function insertFixtureUser(): Promise<number> {
  const row = await testDb
    .insertInto('users')
    .values({
      email: `${crypto.randomUUID()}@catavento.test`,
      name: 'Fixture',
      password_hash: await hashPassword('whatever-12345'),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertReservation(code: string): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({ name: `Room-${code}`, capacity: 2, pets_allowed: false, default_min_stay: 1, total_units: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();

  const reservation = await testDb
    .insertInto('reservations')
    .values({
      room_id: room.id,
      code,
      status: 'confirmed',
      check_in: '2026-08-10',
      check_out: '2026-08-12',
      guests: 2,
      total_cents: 20000,
      deposit_cents: 10000,
      guest_name: 'Guest',
      guest_email: 'guest@example.com',
      guest_phone: '11999998888',
      expires_at: new Date(Date.now() + 30 * 60 * 1000),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return reservation.id;
}

async function insertPayment(input: {
  reservationId: number;
  kind: 'deposit' | 'balance' | 'extra' | 'refund';
  amountCents: number;
  receivedAt: Date;
  changedBy?: number | null;
}): Promise<number> {
  const row = await testDb
    .insertInto('payments')
    .values({
      reservation_id: input.reservationId,
      method: 'cash',
      kind: input.kind,
      amount_cents: input.amountCents,
      status: 'received',
      received_at: input.receivedAt,
      changed_by: input.changedBy ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertMovement(input: {
  kind: 'income' | 'expense';
  amountCents: number;
  occurredOn: string;
  createdBy: number;
  saleItemId?: number;
  quantity?: number;
}): Promise<number> {
  const row = await testDb
    .insertInto('cash_movements')
    .values({
      kind: input.kind,
      amount_cents: input.amountCents,
      occurred_on: input.occurredOn,
      created_by: input.createdBy,
      sale_item_id: input.saleItemId ?? null,
      quantity: input.quantity ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertSaleItem(name: string): Promise<number> {
  const row = await testDb
    .insertInto('cash_sale_items')
    .values({ name })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

describe('authorization', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/panel/cash/ledger?from=2026-08-01&to=2026-08-31' });
    expect(response.statusCode).toBe(401);
  });

  it('403s without cash.view', async () => {
    const roleId = await createRoleWithPermissions(testDb, ['cash.income']);
    const token = await createSessionCookieForRole(testDb, roleId);
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/ledger?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('does not duplicate or drop a reservation payment (§ 1 principle)', () => {
  it('a received payment inside the range appears in the ledger EXACTLY once', async () => {
    const fixtureUser = await insertFixtureUser();
    const reservationId = await insertReservation('LEDGER01');
    await insertPayment({
      reservationId,
      kind: 'deposit',
      amountCents: 10000,
      receivedAt: new Date('2026-08-15T12:00:00.000Z'),
      changedBy: fixtureUser,
    });

    const token = await tokenWithCashView();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/ledger?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // The core guard: nothing else was inserted, so the ledger must contain
    // exactly this one entry — not zero (the payment silently dropped) and
    // not two (a copy sitting alongside the live read). Either direction of
    // breakage on § 1's "read, don't copy" principle fails this exact line.
    expect(body.entries).toHaveLength(1);

    const matchingEntries = body.entries.filter(
      (e: { source: string; reservation_id: number | null }) =>
        e.source === 'reservation_payment' && e.reservation_id === reservationId,
    );
    expect(matchingEntries).toHaveLength(1);
    expect(matchingEntries[0]).toMatchObject({
      kind: 'income',
      amount_cents: 10000,
      date: '2026-08-15',
      registered_by: fixtureUser,
    });

    // Cross-check against the source of truth directly: the ledger's count
    // of reservation-income entries for this reservation must equal the
    // actual row count in `payments` — if a future change ever inserts a
    // mirroring cash_movement for a received payment (the exact anti-pattern
    // § 1 warns against), this count diverges from 1.
    const paymentRowCount = await testDb
      .selectFrom('payments')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('reservation_id', '=', reservationId)
      .where('status', '=', 'received')
      .executeTakeFirstOrThrow();
    expect(Number(paymentRowCount.count)).toBe(matchingEntries.length);
  });

  it('two different received payments on the same reservation each appear once, not merged or duplicated', async () => {
    const fixtureUser = await insertFixtureUser();
    const reservationId = await insertReservation('LEDGER02');
    await insertPayment({
      reservationId,
      kind: 'deposit',
      amountCents: 10000,
      receivedAt: new Date('2026-08-05T10:00:00.000Z'),
      changedBy: fixtureUser,
    });
    await insertPayment({
      reservationId,
      kind: 'balance',
      amountCents: 10000,
      receivedAt: new Date('2026-08-20T10:00:00.000Z'),
      changedBy: fixtureUser,
    });

    const token = await tokenWithCashView();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/ledger?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const body = response.json();
    expect(body.entries).toHaveLength(2);
    expect(body.totals.reservation_income_cents).toBe(20000);
  });

  it('a pending (not yet received) payment never appears in the ledger', async () => {
    const reservationId = await insertReservation('LEDGER03');
    await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservationId,
        method: 'asaas_pix',
        kind: 'deposit',
        amount_cents: 10000,
        status: 'pending',
        asaas_payment_id: 'pay_pending_ledger',
      })
      .execute();

    const token = await tokenWithCashView();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/ledger?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.json().entries).toHaveLength(0);
  });
});

describe('date range boundary (UTC, inclusive on both ends)', () => {
  it('includes a payment received exactly at the start and end instants of the range, excludes just outside it', async () => {
    const fixtureUser = await insertFixtureUser();
    const reservationId = await insertReservation('LEDGER04');

    await insertPayment({
      reservationId,
      kind: 'deposit',
      amountCents: 1000,
      receivedAt: new Date('2026-08-01T00:00:00.000Z'), // exact start, UTC
      changedBy: fixtureUser,
    });
    await insertPayment({
      reservationId,
      kind: 'balance',
      amountCents: 2000,
      receivedAt: new Date('2026-08-31T23:59:59.999Z'), // exact end, UTC
      changedBy: fixtureUser,
    });
    await insertPayment({
      reservationId,
      kind: 'extra',
      amountCents: 4000,
      receivedAt: new Date('2026-07-31T23:59:59.999Z'), // 1ms before the range
      changedBy: fixtureUser,
    });
    await insertPayment({
      reservationId,
      kind: 'extra',
      amountCents: 8000,
      receivedAt: new Date('2026-09-01T00:00:00.000Z'), // 1ms after the range
      changedBy: fixtureUser,
    });

    const token = await tokenWithCashView();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/ledger?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const body = response.json();
    expect(body.totals.reservation_income_cents).toBe(1000 + 2000);
    const dates = body.entries.map((e: { date: string }) => e.date).sort();
    expect(dates).toEqual(['2026-08-01', '2026-08-31']);
  });
});

describe('net calculation, including a refund', () => {
  it('reservation income + sale income - expenses - refunds = net, with a hand-computed expected value', async () => {
    const fixtureUser = await insertFixtureUser();
    const reservationId = await insertReservation('LEDGER05');

    await insertPayment({
      reservationId,
      kind: 'deposit',
      amountCents: 20000,
      receivedAt: new Date('2026-08-10T12:00:00.000Z'),
      changedBy: fixtureUser,
    });
    await insertPayment({
      reservationId,
      kind: 'refund',
      amountCents: 2000,
      receivedAt: new Date('2026-08-12T12:00:00.000Z'),
      changedBy: fixtureUser,
    });
    await insertMovement({ kind: 'income', amountCents: 5000, occurredOn: '2026-08-15', createdBy: fixtureUser });
    await insertMovement({ kind: 'expense', amountCents: 3000, occurredOn: '2026-08-16', createdBy: fixtureUser });

    const token = await tokenWithCashView();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/ledger?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const totals = response.json().totals;
    expect(totals).toEqual({
      reservation_income_cents: 20000,
      sale_income_cents: 5000,
      expense_cents: 3000,
      refund_cents: 2000,
      net_cents: 20000 + 5000 - 3000 - 2000, // = 20000
    });
  });

  it('a refund shows up as an expense-side entry and pulls the net down by exactly its amount', async () => {
    const fixtureUser = await insertFixtureUser();
    const reservationId = await insertReservation('LEDGER06');

    await insertPayment({
      reservationId,
      kind: 'deposit',
      amountCents: 10000,
      receivedAt: new Date('2026-08-10T12:00:00.000Z'),
      changedBy: fixtureUser,
    });

    const token = await tokenWithCashView();
    const app = buildApp();

    const beforeRefund = await app.inject({
      method: 'GET',
      url: '/panel/cash/ledger?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(beforeRefund.json().totals.net_cents).toBe(10000);

    await insertPayment({
      reservationId,
      kind: 'refund',
      amountCents: 4000,
      receivedAt: new Date('2026-08-11T12:00:00.000Z'),
      changedBy: fixtureUser,
    });

    const afterRefund = await app.inject({
      method: 'GET',
      url: '/panel/cash/ledger?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    const body = afterRefund.json();

    expect(body.totals.net_cents).toBe(10000 - 4000);
    expect(body.totals.refund_cents).toBe(4000);

    const refundEntry = body.entries.find((e: { kind: string }) => e.kind === 'expense');
    expect(refundEntry).toMatchObject({
      source: 'reservation_payment',
      kind: 'expense',
      amount_cents: 4000,
      reservation_id: reservationId,
    });
    expect(refundEntry.concept).toContain('Reembolso');
  });
});

describe('hybrid catalog sale (§ 6, 10B)', () => {
  it('a catalog sale with no description shows the item name and quantity as its concept', async () => {
    const fixtureUser = await insertFixtureUser();
    const saleItemId = await insertSaleItem('Cerveja');
    await insertMovement({
      kind: 'income',
      amountCents: 2400,
      occurredOn: '2026-08-15',
      createdBy: fixtureUser,
      saleItemId,
      quantity: 2,
    });

    const token = await tokenWithCashView();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/ledger?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const entry = response.json().entries.find((e: { source: string }) => e.source === 'cash_movement');
    expect(entry.concept).toBe('Cerveja (x2)');
    expect(entry.amount_cents).toBe(2400);
  });

  it('a typed description wins over the derived "item (xN)" concept when both are present', async () => {
    const fixtureUser = await insertFixtureUser();
    const saleItemId = await insertSaleItem('Cerveja');
    await testDb
      .insertInto('cash_movements')
      .values({
        kind: 'income',
        amount_cents: 2400,
        occurred_on: '2026-08-15',
        created_by: fixtureUser,
        sale_item_id: saleItemId,
        quantity: 2,
        description: 'Cerveja para o casal do 101',
      })
      .execute();

    const token = await tokenWithCashView();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/ledger?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const entry = response.json().entries.find((e: { source: string }) => e.source === 'cash_movement');
    expect(entry.concept).toBe('Cerveja para o casal do 101');
  });

  it('a deactivated sale item still shows its name on a past sale (history, not a live lookup)', async () => {
    const fixtureUser = await insertFixtureUser();
    const saleItemId = await insertSaleItem('Tour lancha');
    await insertMovement({
      kind: 'income',
      amountCents: 5000,
      occurredOn: '2026-08-15',
      createdBy: fixtureUser,
      saleItemId,
      quantity: 1,
    });
    await testDb.updateTable('cash_sale_items').set({ active: false }).where('id', '=', saleItemId).execute();

    const token = await tokenWithCashView();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/ledger?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const entry = response.json().entries.find((e: { source: string }) => e.source === 'cash_movement');
    expect(entry.concept).toBe('Tour lancha (x1)');
  });
});
