/**
 * sdd/asaas-pagarme-migration design (obs #257), decision A9 — integration
 * tests for `POST /webhooks/pagarme`. Focus: the signature gate rejects
 * BEFORE any DB write (the single most important correctness property of
 * this route per the task brief), and a validly-signed delivery reaches
 * the event-routing skeleton and acks 200.
 *
 * Uses `app.inject` against a real Fastify instance (same pattern as
 * `webhooksChannex.test.ts`) with a SYNTHETIC secret/signature — no real
 * Pagar.me webhook delivery exists yet (task brief, no live account).
 */
import Fastify from 'fastify';
import { createHmac } from 'node:crypto';
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

process.env.PAGARME_WEBHOOK_SECRET = 'pagarme-test-webhook-secret';

const { testDb } = await import('../../db/testClient.js');
const { registerErrorHandler } = await import('../../errorHandler.js');
const { PAGARME_SIGNATURE_HEADER, PAGARME_SIGNATURE_ALGORITHM } = await import('../verifyPagarmeSignature.js');
const webhooksPagarmePlugin = (await import('../webhooksPagarme.js')).default;

const SECRET = process.env.PAGARME_WEBHOOK_SECRET;

function buildApp() {
  const app = Fastify();
  // Registered with the same `/api` prefix as `src/index.ts` so these tests
  // exercise the real served path (`/api/webhooks/pagarme`), not a path
  // that only exists in isolation.
  app.register(webhooksPagarmePlugin, { prefix: '/api' });
  registerErrorHandler(app);
  return app;
}

function sign(rawBody: string): string {
  return createHmac(PAGARME_SIGNATURE_ALGORITHM, SECRET).update(rawBody).digest('hex');
}

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE payments, reservation_nights, reservations, room_rates, rooms RESTART IDENTITY CASCADE`.execute(testDb);
}

async function seedPendingPayment(): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({ name: 'Casal', capacity: 2, pets_allowed: false, default_min_stay: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();
  await testDb.insertInto('room_rates').values({ room_id: room.id, occupancy: 2, weekday_cents: 10000, weekend_cents: 15000 }).execute();
  const reservation = await testDb
    .insertInto('reservations')
    .values({
      room_id: room.id,
      code: 'PGWH0001',
      status: 'pending_payment',
      guest_name: 'Maria Silva',
      guest_email: 'maria@example.com',
      guest_phone: '11999998888',
      check_in: '2026-10-10',
      check_out: '2026-10-12',
      guests: 2,
      total_cents: 20000,
      deposit_cents: 10000,
      expires_at: new Date(Date.now() + 30 * 60 * 1000),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const payment = await testDb
    .insertInto('payments')
    .values({
      reservation_id: reservation.id,
      kind: 'deposit',
      method: 'pagarme_pix',
      status: 'pending',
      amount_cents: 10000,
      provider: 'pagarme',
      provider_payment_id: 'or_test_1',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return payment.id;
}

async function countPayments(): Promise<number> {
  const result = await testDb.selectFrom('payments').select((eb) => eb.fn.countAll().as('count')).executeTakeFirstOrThrow();
  return Number(result.count);
}

async function fetchPaymentStatus(paymentId: number): Promise<string> {
  const row = await testDb.selectFrom('payments').select('status').where('id', '=', paymentId).executeTakeFirstOrThrow();
  return row.status;
}

beforeEach(async () => {
  await resetDb();
});

describe('POST /webhooks/pagarme — signature gate rejects before any DB write', () => {
  it('missing signature header -> 401, zero payment rows written, pending row untouched', async () => {
    const paymentId = await seedPendingPayment();
    const countBefore = await countPayments();

    const app = buildApp();
    const body = JSON.stringify({ type: 'order.paid', data: { id: 'or_test_1' } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/pagarme',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });

    expect(response.statusCode).toBe(401);
    expect(await countPayments()).toBe(countBefore);
    expect(await fetchPaymentStatus(paymentId)).toBe('pending');
  });

  it('tampered body (signature computed over a different payload) -> 401, zero DB writes', async () => {
    const paymentId = await seedPendingPayment();
    const countBefore = await countPayments();

    const app = buildApp();
    const signedBody = JSON.stringify({ type: 'order.paid', data: { id: 'or_test_1' } });
    const signature = sign(signedBody);
    const actuallySentBody = JSON.stringify({ type: 'order.paid', data: { id: 'or_DIFFERENT' } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/pagarme',
      headers: { 'content-type': 'application/json', [PAGARME_SIGNATURE_HEADER]: signature },
      payload: actuallySentBody,
    });

    expect(response.statusCode).toBe(401);
    expect(await countPayments()).toBe(countBefore);
    expect(await fetchPaymentStatus(paymentId)).toBe('pending');
  });

  it('wrong secret -> 401, zero DB writes', async () => {
    const paymentId = await seedPendingPayment();
    const countBefore = await countPayments();

    const app = buildApp();
    const body = JSON.stringify({ type: 'order.paid', data: { id: 'or_test_1' } });
    const wrongSignature = createHmac(PAGARME_SIGNATURE_ALGORITHM, 'wrong-secret').update(body).digest('hex');

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/pagarme',
      headers: { 'content-type': 'application/json', [PAGARME_SIGNATURE_HEADER]: wrongSignature },
      payload: body,
    });

    expect(response.statusCode).toBe(401);
    expect(await countPayments()).toBe(countBefore);
    expect(await fetchPaymentStatus(paymentId)).toBe('pending');
  });
});

describe('POST /webhooks/pagarme — valid signature reaches the event-routing skeleton', () => {
  it('order.paid with a correct signature -> 200, acked (confirmation wiring deferred to PR 4)', async () => {
    const paymentId = await seedPendingPayment();
    const countBefore = await countPayments();

    const app = buildApp();
    const body = JSON.stringify({ type: 'order.paid', data: { id: 'or_test_1' } });
    const signature = sign(body);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/pagarme',
      headers: { 'content-type': 'application/json', [PAGARME_SIGNATURE_HEADER]: signature },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    // Skeleton only, per task brief — no reservation-confirmation logic
    // exists here yet (that's task A13/A14, PR 4), so nothing in the DB
    // changes even on a validly-signed order.paid delivery.
    expect(await countPayments()).toBe(countBefore);
    expect(await fetchPaymentStatus(paymentId)).toBe('pending');
  });

  it.each(['order.payment_failed', 'charge.refunded', 'checkout.canceled'])(
    '%s with a correct signature -> 200, acked',
    async (type) => {
      const app = buildApp();
      const body = JSON.stringify({ type, data: { id: 'or_test_1' } });
      const signature = sign(body);

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/pagarme',
        headers: { 'content-type': 'application/json', [PAGARME_SIGNATURE_HEADER]: signature },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ received: true });
    },
  );

  it('an unrecognized event type with a correct signature -> 200, no error', async () => {
    const app = buildApp();
    const body = JSON.stringify({ type: 'some.future.event', data: { id: 'or_test_1' } });
    const signature = sign(body);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/pagarme',
      headers: { 'content-type': 'application/json', [PAGARME_SIGNATURE_HEADER]: signature },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
  });
});
