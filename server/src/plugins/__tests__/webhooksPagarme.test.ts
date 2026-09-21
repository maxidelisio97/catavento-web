/**
 * sdd/asaas-pagarme-migration design (obs #257), decision A9/A14 —
 * integration tests for `POST /webhooks/pagarme`. Focus: the signature gate
 * rejects BEFORE any DB write (the single most important correctness
 * property of this route), `order.paid` is the ONLY event that confirms a
 * reservation (post-signature-verification only), and
 * `order.payment_failed`/`checkout.canceled`/`charge.refunded` never do.
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
  // that only exists in isolation. `db: testDb` (task A14 — the route now
  // writes to the DB, PR 3's skeleton never needed this override).
  app.register(webhooksPagarmePlugin, { prefix: '/api', db: testDb });
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
  await testDb.insertInto('room_units').values({ room_id: room.id, label: `${room.id}-1` }).execute();
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

describe('POST /webhooks/pagarme — task A14: order.paid is the ONLY event that confirms, post-signature-verification only', () => {
  it('order.paid with a correct signature -> 200, CONFIRMS the reservation via the same processPaymentReceived path the Asaas webhook uses', async () => {
    const paymentId = await seedPendingPayment();

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
    expect(await fetchPaymentStatus(paymentId)).toBe('received');

    const reservation = await testDb
      .selectFrom('reservations')
      .select('status')
      .where('id', '=', (await testDb.selectFrom('payments').select('reservation_id').where('id', '=', paymentId).executeTakeFirstOrThrow()).reservation_id)
      .executeTakeFirstOrThrow();
    expect(reservation.status).toBe('confirmed');
  });

  it('order.paid for an unknown provider_payment_id -> 200 (ack, per idempotent-webhook convention), zero DB writes', async () => {
    const countBefore = await countPayments();
    const app = buildApp();
    const body = JSON.stringify({ type: 'order.paid', data: { id: 'or_does_not_exist' } });
    const signature = sign(body);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/pagarme',
      headers: { 'content-type': 'application/json', [PAGARME_SIGNATURE_HEADER]: signature },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(await countPayments()).toBe(countBefore);
  });

  it.each(['order.payment_failed', 'checkout.canceled'])(
    '%s with a correct signature -> 200, marks the pending payment FAILED, never confirms',
    async (type) => {
      const paymentId = await seedPendingPayment();

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
      expect(await fetchPaymentStatus(paymentId)).toBe('failed');

      const reservation = await testDb
        .selectFrom('reservations')
        .select('status')
        .where(
          'id',
          '=',
          (await testDb.selectFrom('payments').select('reservation_id').where('id', '=', paymentId).executeTakeFirstOrThrow())
            .reservation_id,
        )
        .executeTakeFirstOrThrow();
      // Never confirmed by a failure/cancellation event — stays exactly
      // where seedPendingPayment left it.
      expect(reservation.status).toBe('pending_payment');
    },
  );

  it('order.payment_failed never downgrades an already-RECEIVED payment (out-of-order/duplicate delivery race)', async () => {
    const paymentId = await seedPendingPayment();
    // Simulate order.paid having already landed (e.g. a duplicate/
    // out-of-order delivery of order.payment_failed arriving after it).
    await testDb.updateTable('payments').set({ status: 'received', received_at: new Date() }).where('id', '=', paymentId).execute();

    const app = buildApp();
    const body = JSON.stringify({ type: 'order.payment_failed', data: { id: 'or_test_1' } });
    const signature = sign(body);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/pagarme',
      headers: { 'content-type': 'application/json', [PAGARME_SIGNATURE_HEADER]: signature },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    // Scoped update (`.where('status', '=', 'pending')`) never fires against
    // an already-received row — status must stay 'received', never regress.
    expect(await fetchPaymentStatus(paymentId)).toBe('received');
  });

  it('charge.refunded with a correct signature -> 200, LOG-ONLY: zero DB writes, reservation untouched (refund logic out of scope per design)', async () => {
    const paymentId = await seedPendingPayment();
    const countBefore = await countPayments();

    const app = buildApp();
    const body = JSON.stringify({ type: 'charge.refunded', data: { id: 'or_test_1' } });
    const signature = sign(body);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/pagarme',
      headers: { 'content-type': 'application/json', [PAGARME_SIGNATURE_HEADER]: signature },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(await countPayments()).toBe(countBefore);
    // charge.refunded never touches payments.status either — log-only means
    // log-only, not "marks failed".
    expect(await fetchPaymentStatus(paymentId)).toBe('pending');
  });

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

/**
 * SPECULATIVE — synthetic payloads only, per the route's own docstring
 * ("UNVERIFIED — do not narrow this without a real captured webhook to
 * confirm against", task B1 still open). These tests do NOT prove what
 * Pagar.me actually sends; they only prove the fallback chain the code
 * itself already implements (`data?.order?.id ?? data?.charge?.id ??
 * data?.id`) behaves as written for each of the three accepted shapes, plus
 * the "none matched" branch. Do not cite these as evidence of the real
 * Pagar.me envelope shape.
 */
describe('POST /webhooks/pagarme — objectId fallback chain (SPECULATIVE, synthetic shapes only — see docstring)', () => {
  it('id nested under data.order.id only (no data.id, no data.charge.id) -> extracted and processed (order.paid confirms)', async () => {
    const paymentId = await seedPendingPayment();

    const app = buildApp();
    const body = JSON.stringify({ type: 'order.paid', data: { order: { id: 'or_test_1' } } });
    const signature = sign(body);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/pagarme',
      headers: { 'content-type': 'application/json', [PAGARME_SIGNATURE_HEADER]: signature },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(await fetchPaymentStatus(paymentId)).toBe('received');
  });

  it('id nested under data.charge.id only (no data.id, no data.order.id) -> extracted and processed (order.paid confirms)', async () => {
    const paymentId = await seedPendingPayment();

    const app = buildApp();
    const body = JSON.stringify({ type: 'order.paid', data: { charge: { id: 'or_test_1' } } });
    const signature = sign(body);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/pagarme',
      headers: { 'content-type': 'application/json', [PAGARME_SIGNATURE_HEADER]: signature },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(await fetchPaymentStatus(paymentId)).toBe('received');
  });

  it('none of data.id/data.order.id/data.charge.id present for a known event type -> 200 ack, log-only, zero DB writes (documented "no object id found" branch)', async () => {
    const paymentId = await seedPendingPayment();
    const countBefore = await countPayments();

    const app = buildApp();
    // A known event type, but the envelope carries none of the three
    // accepted id shapes anywhere under `data`.
    const body = JSON.stringify({ type: 'order.paid', data: { unrelated_field: 'no id here' } });
    const signature = sign(body);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/pagarme',
      headers: { 'content-type': 'application/json', [PAGARME_SIGNATURE_HEADER]: signature },
      payload: body,
    });

    // No crash, no retry-loop trigger (500), no silent confirmation: safe
    // 200 ack with zero DB writes, exactly as the route's own comment
    // ("nothing to look up, ack and move on") describes.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(await countPayments()).toBe(countBefore);
    expect(await fetchPaymentStatus(paymentId)).toBe('pending');
  });
});
