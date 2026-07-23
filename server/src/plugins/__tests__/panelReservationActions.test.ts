/**
 * Integration tests for SPEC-modulo-7-gestion-operativa.md § 5.4 (payment)
 * and § 6 (check-in/check-out).
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import {
  Kysely,
  PostgresDialect,
  sql,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
} from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb, testPool } from '../../db/testClient.js';
import type { DB } from '../../db/types.js';
import { registerErrorHandler } from '../../errorHandler.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';

// Test-only Kysely plugin that inserts an artificial delay after every query
// result comes back. Used by exactly one test to force a genuine race
// between two concurrent requests' SELECT+INSERT round trips — see that
// test's comment for why a bare Promise.all isn't reliable enough on its own.
class ArtificialRaceWindowPlugin implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs) {
    return args.node;
  }
  async transformResult(args: PluginTransformResultArgs) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return args.result;
  }
}

const createCustomer = vi.fn();
const createPayment = vi.fn();
const getPayment = vi.fn();
const getPixQrCode = vi.fn();

vi.mock('../../asaasClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../asaasClient.js')>();
  return {
    ...actual,
    createCustomer: (...args: unknown[]) => createCustomer(...args),
    createPayment: (...args: unknown[]) => createPayment(...args),
    getPayment: (...args: unknown[]) => getPayment(...args),
    getPixQrCode: (...args: unknown[]) => getPixQrCode(...args),
  };
});

const { default: panelReservationActionsPlugin } = await import('../panelReservationActions.js');

function buildApp(db: Kysely<DB> = testDb) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelReservationActionsPlugin, { db });
  registerErrorHandler(app);
  return app;
}

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE payments, reservation_nights, reservations, room_units, rooms, sessions, users RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

async function insertRoom(): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({ name: 'Casal', capacity: 2, pets_allowed: false, default_min_stay: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();
  return room.id;
}

interface ReservationFixtureOptions {
  roomId: number;
  status?: string;
  totalCents?: number;
  code?: string;
}

async function insertReservation(options: ReservationFixtureOptions): Promise<{ id: number; code: string }> {
  const code = options.code ?? `CAT-${randomBytes(4).toString('hex')}`;
  const row = await testDb
    .insertInto('reservations')
    .values({
      room_id: options.roomId,
      check_in: '2026-09-01',
      check_out: '2026-09-03',
      guests: 2,
      status: options.status ?? 'confirmed',
      total_cents: options.totalCents ?? 20000,
      guest_name: 'Maria Silva',
      guest_email: 'maria@example.com',
      guest_phone: '11999998888',
      code,
    })
    .returning(['id', 'code'])
    .executeTakeFirstOrThrow();

  return { id: row.id, code: row.code as string };
}

async function insertPayment(reservationId: number, amountCents: number, status: string): Promise<void> {
  await testDb
    .insertInto('payments')
    .values({
      reservation_id: reservationId,
      asaas_payment_id: `pay_${randomBytes(6).toString('hex')}`,
      method: 'asaas_pix',
      kind: 'deposit',
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

beforeEach(async () => {
  await resetDb();
  createCustomer.mockReset();
  createPayment.mockReset();
  getPayment.mockReset();
  getPixQrCode.mockReset();
});

describe('POST /panel/reservations/:code/payment', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/NOPE/payment',
      payload: { kind: 'balance', method: 'cash', amount_cents: 5000 },
    });
    expect(response.statusCode).toBe(401);
  });

  it('404 when the reservation code does not exist', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/NOPE/payment',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'cash', amount_cents: 5000 },
    });
    expect(response.statusCode).toBe(404);
  });

  it('409 when the reservation is cancelled', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, status: 'cancelled' });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'cash', amount_cents: 5000 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('RESERVATION_NOT_PAYABLE');
  });

  it('409 when the reservation is pending_payment (unconfirmed web reservation, exposed to the lazy expiry sweep)', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, status: 'pending_payment' });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'deposit', method: 'cash', amount_cents: 5000 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('RESERVATION_NOT_PAYABLE');

    const row = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('cash: records a received payment in the act, with changed_by set to the operator', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'cash', amount_cents: 5000, idempotency_key: randomUUID() },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ method: 'cash', payment_id: expect.any(Number), status: 'received' });

    const row = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('received');
    expect(row.kind).toBe('balance');
    expect(row.method).toBe('cash');
    expect(row.amount_cents).toBe(5000);
    expect(row.asaas_payment_id).toBeNull();
    expect(row.changed_by).not.toBeNull();
  });

  it('cash: 400 IDEMPOTENCY_KEY_REQUIRED without idempotency_key, nothing inserted', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'cash', amount_cents: 5000 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const row = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  // Second risk-review finding: a SEQUENTIAL pair of requests (await one,
  // then await the other) fully serializes on its own via the JS event loop
  // — the first request's transaction always commits before the second one's
  // queries even start. That proves the dedupe SELECT works, but proves
  // NOTHING about the advisory lock, since a sequential test passes exactly
  // the same with or without it.
  //
  // Keep this concurrent (Promise.all) — do not "simplify" it back to two
  // sequential awaits, that silently deletes the coverage. That said: this
  // Promise.all alone is a SMOKE test, not a proof. Verified by hand (ran it
  // 8x with `pg_advisory_xact_lock` removed from registerPayment): on fast
  // localhost Postgres, both requests' SELECT+INSERT round trips consistently
  // completed fully serialized "by luck" every single time — the interleaving
  // this lock guards against never naturally occurred, so this test alone
  // passed 8/8 even with the lock gone. The deterministic proof is the next
  // test below, which forces the exact interleaving by hand instead of hoping
  // for it. Both tests stay: this one is what a real double-submit looks like
  // over HTTP; the next one is what actually catches a regression.
  it('cash: two truly concurrent requests with the SAME idempotency_key never both insert — the network-retry case, raced for real', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId });
    const app = buildApp();
    const idempotencyKey = randomUUID();
    const payload = { kind: 'balance' as const, method: 'cash' as const, amount_cents: 5000, idempotency_key: idempotencyKey };

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/panel/reservations/${reservation.code}/payment`,
        cookies: { [SESSION_COOKIE_NAME]: token },
        payload,
      }),
      app.inject({
        method: 'POST',
        url: `/panel/reservations/${reservation.code}/payment`,
        cookies: { [SESSION_COOKIE_NAME]: token },
        payload,
      }),
    ]);

    const statusCodes = [first.statusCode, second.statusCode].sort();
    expect(statusCodes).toEqual([200, 201]);

    const winner = first.statusCode === 201 ? first : second;
    const loser = first.statusCode === 201 ? second : first;
    expect(loser.json()).toEqual(winner.json());

    const rows = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_cents).toBe(5000);
  });

  // DETERMINISTIC version of the race above, through the REAL registerPayment
  // code path (not a hand-rolled reimplementation of it). A plain Promise.all
  // over HTTP is a coin flip on fast localhost Postgres — both requests'
  // SELECT+INSERT round trips tend to complete fully serialized "by luck"
  // before the interleaving the lock guards against ever occurs (verified: 8
  // consecutive runs of the test above, with the lock removed, all passed).
  // To force the actual race deterministically, this test runs the request
  // through a second app instance whose db client has an artificial delay
  // injected after every query result — wide enough (120ms) that two
  // concurrent requests are guaranteed to both pass the dedupe SELECT before
  // either has committed its INSERT, every single run. This still goes
  // through the real HTTP handler and the real registerPayment function —
  // only the timing is forced, not the logic.
  it('DETERMINISTIC: with the dedupe window artificially widened, two concurrent requests with the SAME key still never both insert', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId });
    const delayedDb = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: testPool }),
      plugins: [new ArtificialRaceWindowPlugin()],
    });
    const app = buildApp(delayedDb);
    const idempotencyKey = randomUUID();
    const payload = { kind: 'balance' as const, method: 'cash' as const, amount_cents: 5000, idempotency_key: idempotencyKey };

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/panel/reservations/${reservation.code}/payment`,
        cookies: { [SESSION_COOKIE_NAME]: token },
        payload,
      }),
      app.inject({
        method: 'POST',
        url: `/panel/reservations/${reservation.code}/payment`,
        cookies: { [SESSION_COOKIE_NAME]: token },
        payload,
      }),
    ]);

    // Both requests must resolve gracefully (200 replay + 201 original) —
    // never a raw 500 from an unhandled unique-constraint violation, and
    // never two 201s.
    const statusCodes = [first.statusCode, second.statusCode].sort();
    expect(statusCodes).toEqual([200, 201]);

    const rows = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('cash: replaying the same idempotency_key with the SAME kind/method/amount_cents returns the existing payment (200)', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId });
    const app = buildApp();
    const idempotencyKey = randomUUID();
    const payload = { kind: 'balance' as const, method: 'cash' as const, amount_cents: 5000, idempotency_key: idempotencyKey };

    const first = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    const rows = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_cents).toBe(5000);
  });

  it('cash: reusing the same idempotency_key with a DIFFERENT amount_cents is 409 IDEMPOTENCY_KEY_REUSED, nothing inserted', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId });
    const app = buildApp();
    const idempotencyKey = randomUUID();

    const first = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'cash', amount_cents: 5000, idempotency_key: idempotencyKey },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'cash', amount_cents: 7500, idempotency_key: idempotencyKey },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('IDEMPOTENCY_KEY_REUSED');

    const rows = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_cents).toBe(5000);
  });

  it('cash: reusing the same idempotency_key with a DIFFERENT kind is 409 IDEMPOTENCY_KEY_REUSED, nothing inserted', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId });
    const app = buildApp();
    const idempotencyKey = randomUUID();

    const first = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'cash', amount_cents: 5000, idempotency_key: idempotencyKey },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'extra', method: 'cash', amount_cents: 5000, idempotency_key: idempotencyKey },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('IDEMPOTENCY_KEY_REUSED');

    const rows = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('cash: two DIFFERENT idempotency_key with the same amount/method are two real payments — legitimate identical installments are not merged', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId });
    const app = buildApp();

    const first = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'cash', amount_cents: 5000, idempotency_key: randomUUID() },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'cash', amount_cents: 5000, idempotency_key: randomUUID() },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().payment_id).not.toBe(second.json().payment_id);

    const rows = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .execute();
    expect(rows).toHaveLength(2);
  });

  it('asaas_pix: 400 without cpf_cnpj, never calls Asaas', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'asaas_pix', amount_cents: 5000 },
    });

    expect(response.statusCode).toBe(400);
    expect(createPayment).not.toHaveBeenCalled();
  });

  it('asaas_pix: generates a QR via Asaas and inserts a pending balance payment', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId });
    createCustomer.mockResolvedValue({ id: 'cus_1' });
    createPayment.mockResolvedValue({ id: 'pay_bal_1', status: 'PENDING', invoiceUrl: 'https://asaas.test/inv/1' });
    getPixQrCode.mockResolvedValue({ encodedImage: 'img', payload: 'copy', expirationDate: '2026-09-01T00:00:00Z' });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'asaas_pix', amount_cents: 5000, cpf_cnpj: '12345678900' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().method).toBe('pix');

    const row = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(row.kind).toBe('balance');
    expect(row.status).toBe('pending');
    expect(row.method).toBe('asaas_pix');
  });
});

describe('POST /panel/reservations/:code/check-in', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'POST', url: '/panel/reservations/NOPE/check-in' });
    expect(response.statusCode).toBe(401);
  });

  it('404 when the reservation code does not exist', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/NOPE/check-in',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(404);
  });

  it('confirmed -> checked_in, sets checked_in_at/by', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, status: 'confirmed' });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/check-in`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'checked_in' });

    const row = await testDb
      .selectFrom('reservations')
      .select(['status', 'checked_in_at', 'checked_in_by'])
      .where('id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('checked_in');
    expect(row.checked_in_at).not.toBeNull();
    expect(row.checked_in_by).not.toBeNull();
  });

  it('409 from pending_payment (no shortcut around an unpaid deposit)', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, status: 'pending_payment' });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/check-in`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('INVALID_TRANSITION');
  });
});

describe('POST /panel/reservations/:code/check-out', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'POST', url: '/panel/reservations/NOPE/check-out' });
    expect(response.statusCode).toBe(401);
  });

  it('409 from confirmed (must be checked_in first)', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, status: 'confirmed' });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/check-out`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('INVALID_TRANSITION');
  });

  it('409 BALANCE_DUE when checked_in with balance_due_cents > 0 — hard block, not a warning', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, status: 'checked_in', totalCents: 20000 });
    // No payments at all: balance_due_cents == total_cents == 20000.
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/check-out`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'BALANCE_DUE', balance_due_cents: 20000 });

    const row = await testDb
      .selectFrom('reservations')
      .select('status')
      .where('id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('checked_in'); // untouched
  });

  it('checked_in -> checked_out once balance_due_cents == 0', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, status: 'checked_in', totalCents: 20000 });
    await insertPayment(reservation.id, 20000, 'received');
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/check-out`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'checked_out' });

    const row = await testDb
      .selectFrom('reservations')
      .select(['status', 'checked_out_at', 'checked_out_by'])
      .where('id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('checked_out');
    expect(row.checked_out_at).not.toBeNull();
    expect(row.checked_out_by).not.toBeNull();
  });

  it('two simultaneous check-outs on the same reservation: one wins (200), the other gets 409 — never both 200', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, status: 'checked_in', totalCents: 20000 });
    await insertPayment(reservation.id, 20000, 'received');
    const app = buildApp();

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/panel/reservations/${reservation.code}/check-out`,
        cookies: { [SESSION_COOKIE_NAME]: token },
      }),
      app.inject({
        method: 'POST',
        url: `/panel/reservations/${reservation.code}/check-out`,
        cookies: { [SESSION_COOKIE_NAME]: token },
      }),
    ]);

    const statusCodes = [first.statusCode, second.statusCode].sort();
    expect(statusCodes).toEqual([200, 409]);

    const winner = first.statusCode === 200 ? first : second;
    const loser = first.statusCode === 200 ? second : first;
    expect(winner.json()).toEqual({ status: 'checked_out' });
    expect(loser.json().error).toBe('INVALID_TRANSITION');

    const row = await testDb
      .selectFrom('reservations')
      .select(['status', 'checked_out_by'])
      .where('id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('checked_out');
    // Exactly one write won — the audit column reflects a single actor, not
    // whichever request happened to run last.
    expect(row.checked_out_by).not.toBeNull();
  });
});
