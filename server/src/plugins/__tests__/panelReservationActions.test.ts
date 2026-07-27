/**
 * Integration tests for SPEC-modulo-7-gestion-operativa.md § 5.4 (payment)
 * and § 6 (check-in/check-out).
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { Kysely, PostgresDialect, sql, type RootOperationNode } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb, testPool } from '../../db/testClient.js';
import type { DB } from '../../db/types.js';
import { registerErrorHandler } from '../../errorHandler.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';
import { checkIn, registerPayment, InvalidReservationTransitionError } from '../../panel/reservationActions.js';
import { OverpaymentError } from '../../reservations/overpaymentGuard.js';
import { createOrReuseAsaasPayment } from '../../reservations/createOrReusePayment.js';
import { createQueryStartSignal, createQueryTimingPlugin, rawSqlContains } from '../../test-support/queryBarrier.js';

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

async function insertUnit(roomId: number, label = 'A1'): Promise<number> {
  const unit = await testDb
    .insertInto('room_units')
    .values({ room_id: roomId, label })
    .returning('id')
    .executeTakeFirstOrThrow();
  return unit.id;
}

async function insertNights(reservationId: number, unitId: number, checkIn: string, checkOut: string): Promise<void> {
  const { eachNightUTC } = await import('../../shared/dateUtils.js');
  const nights = eachNightUTC(checkIn, checkOut);
  await testDb
    .insertInto('reservation_nights')
    .values(nights.map((night) => ({ reservation_id: reservationId, night, room_unit_id: unitId })))
    .execute();
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

  // Identifies the advisory-lock query ITSELF (`SELECT
  // pg_advisory_xact_lock(...)`), not the dedupe SELECT that runs after
  // it. First attempt at this test measured the dedupe SELECT's duration
  // instead and got a false negative (65ms, test failed even WITH the
  // production lock in place): the wait happens on the lock query — the
  // dedupe SELECT never starts until the lock is already held, so by the
  // time it runs it's always fast. Timing the wrong query in the same
  // transaction is its own way of proving nothing — see
  // server/CLAUDE.md's concurrency-test lesson on this.
  function isAdvisoryLockQuery(node: RootOperationNode): boolean {
    return rawSqlContains(node, 'pg_advisory_xact_lock');
  }

  // DETERMINISTIC, same technique as panelMoveReservation.test.ts's
  // same-reservation move test and panelManualReservation.test.ts's
  // FOR UPDATE test: holds the EXACT advisory-lock key registerPayment
  // uses, on a raw connection (simulating a first cash payment already in
  // flight with the SAME idempotency_key, lock acquired, not yet
  // committed), and calls the REAL registerPayment service function
  // concurrently.
  it('DETERMINISTIC: registerPayment (cash) blocks on the SAME advisory-lock key a concurrent request with the SAME idempotency_key holds, and replays instead of double-inserting', async () => {
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId });
    const user = await testDb
      .insertInto('users')
      .values({ email: 'operator@catavento.test', name: 'Operator', password_hash: await hashPassword('whatever') })
      .returning('id')
      .executeTakeFirstOrThrow();
    const idempotencyKey = randomUUID();

    await Promise.all([
      testDb.selectFrom('reservations').select('id').limit(1).execute(),
      testDb.selectFrom('reservations').select('id').limit(1).execute(),
    ]);

    // ENTIRE holder lifecycle (connect -> release) in try/finally — not
    // just the final commit — so a failure acquiring the lock itself can
    // never leak the connection while still holding it (see the checkIn
    // test's comment earlier in this file for why this matters: a
    // full-suite run under load found exactly this leak pattern).
    const holder = await testPool.connect();
    const { plugin: timingPlugin, timings } = createQueryTimingPlugin({ match: isAdvisoryLockQuery });
    const { plugin: startSignalPlugin, started } = createQueryStartSignal({ match: isAdvisoryLockQuery });
    const measuredDb = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: testPool }),
      plugins: [timingPlugin, startSignalPlugin],
    });

    let firstPaymentId!: number;
    let paymentPromise!: ReturnType<typeof registerPayment>;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1)', [reservation.id]);

      paymentPromise = registerPayment(measuredDb, {
        code: reservation.code,
        kind: 'balance',
        method: 'cash',
        amountCents: 5000,
        idempotencyKey,
        changedBy: user.id,
      });
      // Never let this leak as an unhandled rejection if the holder's own
      // setup below throws before we reach the real `await paymentPromise` —
      // otherwise it stays orphaned against a lock the holder never
      // released, and rejects later, attributed to whatever test happens to
      // be running at that point (found via a real full-suite cascade).
      paymentPromise.catch(() => {});

      // Wait for registerPayment to actually REACH its own lock
      // acquisition attempt — an event, not a guessed setTimeout margin.
      // registerPayment does a SELECT + assertNotOverpaying before this
      // point, so a fixed-ms guess here was fragile under load: the
      // ORIGINAL version of this test (200-350ms setTimeout) passed 3/3
      // isolated runs and most full-suite runs, but failed 2 out of 5
      // consecutive full-suite runs on this exact assertion once the
      // machine was under sustained load — the margin was real, just not
      // reliably big enough. Waiting for the real event has no margin to
      // get wrong.
      await started;

      // Finish what a real first cash payment does, still holding the
      // lock: insert with the SAME idempotency_key/kind/method/amount.
      const inserted = await holder.query<{ id: number }>(
        `INSERT INTO payments (reservation_id, kind, method, amount_cents, status, changed_by, idempotency_key)
         VALUES ($1, 'balance', 'cash', 5000, 'received', $2, $3) RETURNING id`,
        [reservation.id, user.id, idempotencyKey],
      );
      firstPaymentId = inserted.rows[0]!.id;
      await holder.query('COMMIT');
    } catch (err) {
      // pg_advisory_xact_lock is transaction-scoped: without an explicit
      // ROLLBACK here, a failure between BEGIN and COMMIT leaves the
      // transaction (and the lock inside it) open when release() below
      // returns the connection to the pool — verified by hand: the next
      // checkout of that same connection inherits an aborted transaction
      // (25P02) and the lock is never actually free. release() alone does
      // NOT roll back an open transaction.
      await holder.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      holder.release();
    }

    // Now unblocked: the second call re-reads under its own lock, sees the
    // same idempotency_key already used with a matching intent, and
    // replays instead of inserting a second row.
    const result = await paymentPromise;
    expect(result).toEqual({ method: 'cash', paymentId: firstPaymentId, status: 'received', replayed: true });

    // The proof: registerPayment's OWN advisory-lock acquisition itself is
    // what ran — not some other, unrelated point in the call. (No minimum
    // duration asserted: with `started` as the release signal, the wait
    // window is only as long as the holder's own insert+commit take, which
    // proves ordering, not timing — the correct final result above is what
    // proves the lock actually serialized the two calls.)
    expect(timings).toHaveLength(1);

    const rows = await testDb.selectFrom('payments').selectAll().where('reservation_id', '=', reservation.id).execute();
    expect(rows).toHaveLength(1); // only the holder's — never a second insert
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

  // --- Overpayment guard (overpaymentGuard.ts) ---

  it('cash: 422 OVERPAYMENT when amount_cents exceeds balance_due_cents by even one cent, nothing inserted', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, totalCents: 20000 });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'cash', amount_cents: 20001, idempotency_key: randomUUID() },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('OVERPAYMENT');

    const row = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('cash: paying exactly the remaining balance_due_cents is allowed (closes it to zero, not rejected as overpaying)', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, totalCents: 20000 });
    await insertPayment(reservation.id, 12000, 'received'); // balance_due_cents == 8000
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'cash', amount_cents: 8000, idempotency_key: randomUUID() },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ method: 'cash', payment_id: expect.any(Number), status: 'received' });
  });

  it('asaas_pix: 422 OVERPAYMENT when the requested amount exceeds balance_due_cents, never calls Asaas (cheap pre-check, before the lock/transaction)', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, totalCents: 20000 });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'asaas_pix', amount_cents: 20001, cpf_cnpj: '12345678900' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('OVERPAYMENT');
    expect(createCustomer).not.toHaveBeenCalled();
    expect(createPayment).not.toHaveBeenCalled();
  });

  // DETERMINISTIC, same technique as the idempotency lock test above: holds
  // the SAME advisory-lock key on a raw connection (simulating a first cash
  // payment of 15000 already in flight, lock acquired, not yet committed)
  // and calls the REAL registerPayment concurrently with a DIFFERENT
  // idempotency_key (forcing the overpayment path, not the dedupe path —
  // that's a different guard, covered by the test above). Individually each
  // 15000 payment fits under the 20000 total; together they don't — only
  // the re-check under the lock (assertNotOverpayingWithPendingAsaas,
  // called AFTER the dedupe SELECT) catches it. Measures the advisory-lock
  // query itself, not the SELECT that follows it — see the idempotency
  // test's comment for why that distinction matters.
  it('DETERMINISTIC: registerPayment (cash) blocks on the SAME advisory-lock key a concurrent cash payment holds, and rejects the overpaying second payment', async () => {
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, totalCents: 20000 });
    const user = await testDb
      .insertInto('users')
      .values({ email: 'operator2@catavento.test', name: 'Operator', password_hash: await hashPassword('whatever') })
      .returning('id')
      .executeTakeFirstOrThrow();

    await Promise.all([
      testDb.selectFrom('reservations').select('id').limit(1).execute(),
      testDb.selectFrom('reservations').select('id').limit(1).execute(),
    ]);

    // ENTIRE holder lifecycle in try/finally — see the idempotency test's
    // comment above for why.
    const holder = await testPool.connect();
    const { plugin: timingPlugin, timings } = createQueryTimingPlugin({ match: isAdvisoryLockQuery });
    const { plugin: startSignalPlugin, started } = createQueryStartSignal({ match: isAdvisoryLockQuery });
    const measuredDb = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: testPool }),
      plugins: [timingPlugin, startSignalPlugin],
    });

    let firstPaymentId!: number;
    let paymentPromise!: ReturnType<typeof registerPayment>;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1)', [reservation.id]);

      paymentPromise = registerPayment(measuredDb, {
        code: reservation.code,
        kind: 'balance',
        method: 'cash',
        amountCents: 15000,
        idempotencyKey: randomUUID(), // different key: forces the overpayment path, not dedupe
        changedBy: user.id,
      });
      // See the idempotency test's comment above — never let this leak as an
      // unhandled rejection if the holder's setup below throws first.
      paymentPromise.catch(() => {});

      // Event-based, not a guessed setTimeout margin — see the idempotency
      // test's comment above for why.
      await started;

      // Finish what a real first cash payment does, still holding the lock.
      const inserted = await holder.query<{ id: number }>(
        `INSERT INTO payments (reservation_id, kind, method, amount_cents, status, changed_by, idempotency_key)
         VALUES ($1, 'balance', 'cash', 15000, 'received', $2, $3) RETURNING id`,
        [reservation.id, user.id, randomUUID()],
      );
      firstPaymentId = inserted.rows[0]!.id;
      await holder.query('COMMIT');
    } catch (err) {
      // See the idempotency test's comment above — release() alone does NOT
      // roll back an open transaction, and the advisory lock inside it stays
      // held (verified by hand) until an explicit ROLLBACK runs.
      await holder.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      holder.release();
    }

    // Now unblocked: the second payment re-checks balance_due_cents under
    // its own lock, sees only 5000 left (20000 - 15000 already committed),
    // and rejects the 15000 request instead of overpaying.
    await expect(paymentPromise).rejects.toThrow(OverpaymentError);

    expect(timings).toHaveLength(1);

    const rows = await testDb.selectFrom('payments').selectAll().where('reservation_id', '=', reservation.id).execute();
    expect(rows).toHaveLength(1); // only the holder's
    expect(rows[0]!.id).toBe(firstPaymentId);
    expect(rows[0]!.amount_cents).toBe(15000);
  });

  // Two SEQUENTIAL requests of DIFFERENT kind, each individually within
  // balance_due_cents at the moment it's checked (neither is `received` yet
  // — both sit `pending` until their own webhook lands), together exceed the
  // total. No thread race involved.
  //
  // IMPORTANT NUANCE (found while doing the mandatory "remove the guard,
  // confirm it fails" check): `idx_payments_one_pending_per_reservation`
  // (migration 1784587500000) is a DB-level unique index on
  // `reservation_id WHERE status='pending'` — NOT scoped by kind, so it
  // already forbids two simultaneously-pending payments of ANY kind for the
  // same reservation. Verified by hand: commenting out
  // assertNotOverpayingWithPendingAsaas in createOrReusePayment.ts does NOT
  // make this test's second request succeed with 201 — it makes it fail
  // with a raw 500 (unhandled unique-constraint violation) instead of a
  // clean 422. So for this SPECIFIC pure-Asaas-vs-Asaas shape, the money was
  // already safe before this fix; what the fix adds here is turning an
  // unhandled 500 into an intentional, well-typed 422 — real robustness,
  // not decoration. The index does NOT protect the mixed cash+Asaas case
  // below, though (cash inserts straight to 'received', never 'pending', so
  // the index never sees it) — that's the case that was genuinely open.
  it('asaas: two sequential charges of DIFFERENT kind that individually fit but together exceed the balance — clean 422, not the DB unique-index 500', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, totalCents: 20000 });
    createCustomer.mockResolvedValue({ id: 'cus_1' });
    createPayment.mockResolvedValue({ id: 'pay_deposit', status: 'PENDING', invoiceUrl: 'https://asaas.test/inv/deposit' });
    const app = buildApp();

    const first = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'deposit', method: 'asaas_card', amount_cents: 20000, cpf_cnpj: '12345678900' },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'asaas_card', amount_cents: 20000, cpf_cnpj: '12345678900' },
    });

    expect(second.statusCode).toBe(422);
    expect(second.json().error).toBe('OVERPAYMENT');
    expect(createPayment).toHaveBeenCalledTimes(1); // never created the second Asaas charge

    const rows = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('deposit');
  });

  // The genuinely open gap, unlike the pure-Asaas-vs-Asaas case above:
  // idx_payments_one_pending_per_reservation only restricts `pending` rows.
  // Cash inserts straight to `received` — the index never sees it, so it
  // never blocks a cash payment from landing alongside an already-pending
  // Asaas charge. Order 1: Asaas charge created first (still pending, no
  // conflict), THEN a cash payment for the rest of the balance. Verified by
  // hand: this is the one that actually needs assertNotOverpayingWithPendingAsaas
  // in registerPayment's cash branch — commenting it out makes THIS test
  // fail (cash succeeds with 201 instead of 422); it does NOT depend on the
  // check inside createOrReuseAsaasPayment at all (disabling that one alone
  // leaves this test passing).
  it('mixed order 1 — Asaas pending charge created first, then a cash payment that would push the total over: cash is rejected', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, totalCents: 20000 });
    createCustomer.mockResolvedValue({ id: 'cus_1' });
    createPayment.mockResolvedValue({ id: 'pay_deposit', status: 'PENDING', invoiceUrl: 'https://asaas.test/inv/deposit' });
    const app = buildApp();

    const asaasResponse = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'deposit', method: 'asaas_card', amount_cents: 20000, cpf_cnpj: '12345678900' },
    });
    expect(asaasResponse.statusCode).toBe(201);

    const cashResponse = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'cash', amount_cents: 20000, idempotency_key: randomUUID() },
    });

    expect(cashResponse.statusCode).toBe(422);
    expect(cashResponse.json().error).toBe('OVERPAYMENT');

    const rows = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .execute();
    expect(rows).toHaveLength(1); // only the Asaas pending charge, cash never inserted
    expect(rows[0]!.method).toBe('asaas_card');
  });

  // Order 2: cash lands first (goes straight to `received`, no `pending` row
  // involved at all, so the DB unique index has nothing to check against),
  // THEN an Asaas charge is requested for the rest of the balance.
  //
  // NUANCE (found the same way as the pure-Asaas-vs-Asaas one above, by
  // actually verifying instead of assuming): this direction was ALREADY
  // safe before this fix. The outer assertNotOverpaying (received-only, ran
  // unconditionally before the ASAAS_METHODS branch even in the original
  // code) already sees the cash payment as `received` the instant it lands
  // — so it rejects the second request before ever reaching
  // createOrReuseAsaasPayment. Verified by hand: commenting out
  // assertNotOverpayingWithPendingAsaas inside createOrReusePayment.ts does
  // NOT make this test fail. Kept anyway as an explicit regression guard for
  // this direction (the user asked for both orders covered, and "already
  // safe" is exactly the kind of fact that's cheap to lock down and easy to
  // accidentally break later), but it is not proof of the NEW mechanism —
  // order 1 above is.
  it('mixed order 2 — cash payment received first, then an Asaas charge request that would push the total over: Asaas charge is rejected, never calls Asaas', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, totalCents: 20000 });
    const app = buildApp();

    const cashResponse = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'deposit', method: 'cash', amount_cents: 20000, idempotency_key: randomUUID() },
    });
    expect(cashResponse.statusCode).toBe(201);

    const asaasResponse = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'asaas_card', amount_cents: 20000, cpf_cnpj: '12345678900' },
    });

    expect(asaasResponse.statusCode).toBe(422);
    expect(asaasResponse.json().error).toBe('OVERPAYMENT');
    expect(createCustomer).not.toHaveBeenCalled();
    expect(createPayment).not.toHaveBeenCalled();

    const rows = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .execute();
    expect(rows).toHaveLength(1); // only the cash payment, Asaas charge never created
    expect(rows[0]!.method).toBe('cash');
  });

  it('reconciles a stale pending Asaas payment Asaas no longer has as pending — marks it failed locally instead of blocking a legitimate new charge of a different kind', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, totalCents: 20000 });

    // A pending deposit charge old enough to be a reconciliation candidate
    // (created_at < current_date). Without reconciliation, this alone would
    // block the balance charge below (20000 pending + 20000 new > 20000 total).
    await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservation.id,
        asaas_payment_id: 'pay_stale',
        method: 'asaas_pix',
        kind: 'deposit',
        amount_cents: 20000,
        status: 'pending',
        created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      })
      .execute();

    getPayment.mockResolvedValue({ id: 'pay_stale', status: 'OVERDUE', invoiceUrl: 'https://asaas.test/inv/stale' });
    createCustomer.mockResolvedValue({ id: 'cus_1' });
    createPayment.mockResolvedValue({ id: 'pay_new', status: 'PENDING', invoiceUrl: 'https://asaas.test/inv/new' });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'asaas_card', amount_cents: 20000, cpf_cnpj: '12345678900' },
    });

    expect(response.statusCode).toBe(201);
    expect(getPayment).toHaveBeenCalledWith('pay_stale');

    const staleRow = await testDb
      .selectFrom('payments')
      .select('status')
      .where('asaas_payment_id', '=', 'pay_stale')
      .executeTakeFirstOrThrow();
    expect(staleRow.status).toBe('failed');

    const newRow = await testDb
      .selectFrom('payments')
      .select(['status', 'kind'])
      .where('asaas_payment_id', '=', 'pay_new')
      .executeTakeFirstOrThrow();
    expect(newRow.status).toBe('pending');
    expect(newRow.kind).toBe('balance');
  });

  it('a pending Asaas payment created TODAY is never reconciled (never calls Asaas for it) and still correctly counts against the balance', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, totalCents: 20000 });

    await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservation.id,
        asaas_payment_id: 'pay_today',
        method: 'asaas_pix',
        kind: 'deposit',
        amount_cents: 20000,
        status: 'pending',
        // created_at defaults to now() — today, not backdated.
      })
      .execute();

    createCustomer.mockResolvedValue({ id: 'cus_1' });
    createPayment.mockResolvedValue({ id: 'pay_new', status: 'PENDING', invoiceUrl: 'https://asaas.test/inv/new' });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'asaas_card', amount_cents: 20000, cpf_cnpj: '12345678900' },
    });

    // getPayment is never called for the today's-date pending row: it's
    // trusted as still legitimately outstanding, not reconciled — and it
    // correctly blocks this second charge from being created.
    expect(getPayment).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('OVERPAYMENT');
    expect(createPayment).not.toHaveBeenCalled();
  });

  // DETERMINISTIC, same technique as the two cash lock tests above: holds
  // the SAME advisory-lock key createOrReuseAsaasPayment uses, on a raw
  // connection (simulating a first Asaas charge of kind 'deposit' already
  // pending, lock acquired, not yet committed), and calls
  // createOrReuseAsaasPayment directly for a SECOND charge of a DIFFERENT
  // kind ('balance') concurrently. Individually each 20000 fits the 20000
  // total; together they don't — only assertNotOverpayingWithPendingAsaas,
  // called AFTER the dedupe SELECT inside the SAME lock, catches it (proven
  // by the sequential version above, which shows the money is exposed
  // without a thread race at all — this test proves the lock closes the
  // genuinely concurrent variant too). Measures the advisory-lock query
  // itself, same reasoning as the cash tests.
  it('DETERMINISTIC: createOrReuseAsaasPayment blocks on the SAME advisory-lock key a concurrent Asaas charge holds, and rejects the overpaying second charge of a DIFFERENT kind', async () => {
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, totalCents: 20000 });
    createCustomer.mockResolvedValue({ id: 'cus_1' });
    createPayment.mockImplementation(async () => ({
      id: `pay_${randomUUID()}`,
      status: 'PENDING',
      invoiceUrl: 'https://asaas.test/inv/race',
    }));

    await Promise.all([
      testDb.selectFrom('reservations').select('id').limit(1).execute(),
      testDb.selectFrom('reservations').select('id').limit(1).execute(),
    ]);

    // ENTIRE holder lifecycle in try/finally — see the idempotency test's
    // comment above for why.
    const holder = await testPool.connect();
    const { plugin: timingPlugin, timings } = createQueryTimingPlugin({ match: isAdvisoryLockQuery });
    const { plugin: startSignalPlugin, started } = createQueryStartSignal({ match: isAdvisoryLockQuery });
    const measuredDb = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: testPool }),
      plugins: [timingPlugin, startSignalPlugin],
    });

    let firstPaymentId!: number;
    let paymentPromise!: ReturnType<typeof createOrReuseAsaasPayment>;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1)', [reservation.id]);

      paymentPromise = createOrReuseAsaasPayment(measuredDb, {
        reservationId: reservation.id,
        code: reservation.code,
        kind: 'balance',
        method: 'card',
        amountCents: 20000,
        dueDate: '2026-09-05',
        guestName: 'Maria Silva',
        guestEmail: 'maria@example.com',
        guestPhone: '11999998888',
        cpfCnpj: '12345678900',
      });
      // See the idempotency test's comment above — never let this leak as an
      // unhandled rejection if the holder's setup below throws first.
      paymentPromise.catch(() => {});

      // Event-based, not a guessed setTimeout margin — see the idempotency
      // test's comment above for why.
      await started;

      // Finish what a real first Asaas deposit charge does, still holding
      // the lock: insert the pending payment row.
      const inserted = await holder.query<{ id: number }>(
        `INSERT INTO payments (reservation_id, asaas_payment_id, kind, method, amount_cents, status)
         VALUES ($1, $2, 'deposit', 'asaas_card', 20000, 'pending') RETURNING id`,
        [reservation.id, `pay_${randomUUID()}`],
      );
      firstPaymentId = inserted.rows[0]!.id;
      await holder.query('COMMIT');
    } catch (err) {
      // See the idempotency test's comment above — release() alone does NOT
      // roll back an open transaction, and the advisory lock inside it stays
      // held (verified by hand) until an explicit ROLLBACK runs.
      await holder.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      holder.release();
    }

    // Now unblocked: the second charge re-checks balance_due_cents under
    // its own lock, sees the deposit already committed leaves 0 room, and
    // rejects instead of creating a second Asaas charge.
    await expect(paymentPromise).rejects.toThrow(OverpaymentError);

    expect(timings).toHaveLength(1);
    expect(createPayment).not.toHaveBeenCalled(); // never even reached Asaas for the second charge

    const rows = await testDb.selectFrom('payments').selectAll().where('reservation_id', '=', reservation.id).execute();
    expect(rows).toHaveLength(1); // only the holder's
    expect(rows[0]!.id).toBe(firstPaymentId);
    expect(rows[0]!.kind).toBe('deposit');
  });

  // Risk-review finding: assertNotOverpayingWithPendingAsaas only guards the
  // MONEY side of a same-day different-kind double-pending attempt. When the
  // combined amount still fits under balance_due_cents (unlike the "clean
  // 422" test above, where the second amount alone exhausts the balance),
  // the guard lets the second INSERT through — and idx_payments_one_pending_per_reservation
  // (not kind-scoped) rejects it anyway. Before isPendingPaymentUniqueViolation
  // handling, this surfaced as a raw 500. Verified by hand: reverting
  // createOrReusePayment.ts's insert to a bare (un-try/caught) call makes
  // this test fail with a 500 instead of 422.
  it('asaas: two sequential charges of DIFFERENT kind that BOTH fit under the balance still collide on idx_payments_one_pending_per_reservation — clean 422, not a raw 500', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, totalCents: 20000 });
    createCustomer.mockResolvedValue({ id: 'cus_1' });
    createPayment
      .mockResolvedValueOnce({ id: 'pay_deposit', status: 'PENDING', invoiceUrl: 'https://asaas.test/inv/deposit' })
      .mockResolvedValueOnce({ id: 'pay_balance', status: 'PENDING', invoiceUrl: 'https://asaas.test/inv/balance' });
    const app = buildApp();

    const first = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'deposit', method: 'asaas_card', amount_cents: 5000, cpf_cnpj: '12345678900' },
    });
    expect(first.statusCode).toBe(201);

    // 15000 alone still fits under the remaining 15000 (20000 - 5000
    // deposit still pending) — assertNotOverpayingWithPendingAsaas does NOT
    // reject this. The unique index does, because the deposit charge above
    // is still `pending`.
    const second = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/payment`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'balance', method: 'asaas_card', amount_cents: 15000, cpf_cnpj: '12345678900' },
    });

    expect(second.statusCode).toBe(422);
    expect(second.json().error).toBe('OVERPAYMENT');

    const rows = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .execute();
    expect(rows).toHaveLength(1); // the failed insert never lands
    expect(rows[0]!.kind).toBe('deposit');
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

  // DETERMINISTIC: proves check-in shares the SAME lock key as
  // cancel/no-show/move, by holding that exact lock on a raw connection and
  // asserting checkIn genuinely blocks on it — not a uniform-delay race that
  // hopes for a particular interleaving.
  //
  // A uniform-delay approach (the ArtificialRaceWindowPlugin technique used
  // elsewhere in this file) does NOT work for this pair: checkIn is
  // structurally the SHORTER transaction (2 round trips) vs cancel's longer
  // one (lock + read + update + release nights + consistency check, 5+ round
  // trips), so under a uniform per-query delay checkIn always finishes and
  // commits well before cancel even reads status — cancel's own fresh read
  // then correctly sees 'checked_in' and rejects itself with 409. That's a
  // real, valid outcome, but it never exercises the actual danger: checkIn
  // reading a STALE 'confirmed' and blindly writing 'checked_in' AFTER a
  // cancel has already committed and released the nights. Verified by hand:
  // that version of this test passed 4/4 runs even with checkIn's lock
  // removed entirely — it wasn't proving anything.
  //
  // So instead of racing two HTTP requests, this holds the advisory lock
  // directly on a second raw connection (simulating cancel being mid-flight,
  // already holding the lock, not yet committed), calls the real `checkIn`
  // service function concurrently, and asserts it blocks until the lock is
  // released — then, seeing the post-cancel status under its own fresh
  // locked read, rejects instead of resurrecting.
  it('DETERMINISTIC: checkIn blocks on the SAME advisory-lock key a concurrent cancel holds, and rejects once unblocked — never resurrects', async () => {
    const roomId = await insertRoom();
    const unitId = await insertUnit(roomId);
    const reservation = await insertReservation({ roomId, status: 'confirmed' });
    await insertNights(reservation.id, unitId, '2026-09-01', '2026-09-03');
    const user = await testDb
      .insertInto('users')
      .values({ email: 'operator@catavento.test', name: 'Operator', password_hash: await hashPassword('whatever') })
      .returning('id')
      .executeTakeFirstOrThrow();

    // Warm the pool with two genuinely concurrent queries first, so it holds
    // at least 2 idle physical connections before the race starts. Without
    // this, the FIRST query on a cold connection (TCP + auth handshake) on
    // this machine costs ~300-400ms on its own — on the same order as the
    // window below, which made an earlier version of this test look like it
    // was "blocked on the lock" when it was actually just paying that
    // one-time connection cost. Verified by hand: same false "blocked"
    // reading appeared even routed through a brand-new, totally unrelated
    // pool, which proved it had nothing to do with holder's lock at all.
    await Promise.all([
      testDb.selectFrom('reservations').select('id').limit(1).execute(),
      testDb.selectFrom('reservations').select('id').limit(1).execute(),
    ]);

    // Raw connection holding the SAME lock key cancelReservation would use,
    // simulating a cancel that's mid-transaction (lock acquired, not yet
    // committed). The ENTIRE lifecycle from connect() to release() is
    // wrapped in try/finally — not just the final commit — so a failure
    // acquiring the lock itself (BEGIN or pg_advisory_xact_lock, under real
    // load) can never leak the connection while still holding the lock.
    // Found the hard way: a fixed-margin version of this pattern (used here
    // and copied 5x elsewhere) left the BEGIN/lock acquisition unprotected,
    // and a full-suite run under sustained load produced a catastrophic
    // cascade (68/227 tests failing) consistent with exactly this — an
    // orphaned advisory lock on a low reservation id (ids restart at 1 every
    // test via TRUNCATE ... RESTART IDENTITY) blocking most of the rest of
    // the suite. See server/CLAUDE.md's concurrency-test lesson on this.
    const holder = await testPool.connect();
    let checkInSettled = false;
    let checkInPromise!: Promise<void>;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1)', [reservation.id]);

      checkInPromise = checkIn(testDb, { code: reservation.code, changedBy: user.id }).then(
        () => {
          checkInSettled = true;
        },
        (err: unknown) => {
          checkInSettled = true;
          throw err;
        },
      );

      // checkIn must still be blocked on the lock — give it a window it
      // would easily clear if it weren't actually waiting.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(checkInSettled).toBe(false);

      // Finish what a real cancel does, still holding the lock: transition
      // to cancelled and release the nights.
      await holder.query(`UPDATE reservations SET status = 'cancelled' WHERE id = $1`, [reservation.id]);
      await holder.query(`DELETE FROM reservation_nights WHERE reservation_id = $1`, [reservation.id]);
      await holder.query('COMMIT');
    } catch (err) {
      // pg_advisory_xact_lock is transaction-scoped: without an explicit
      // ROLLBACK here, a failure between BEGIN and COMMIT leaves the
      // transaction (and the lock inside it) open when release() below
      // returns the connection to the pool — verified by hand: the next
      // checkout of that same connection inherits an aborted transaction
      // (25P02) and the lock is never actually free. release() alone does
      // NOT roll back an open transaction.
      await holder.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      holder.release();
    }

    // Now unblocked: checkIn's fresh locked read sees 'cancelled', which
    // isn't a valid predecessor of 'checked_in' — it must reject, never
    // silently resurrect the reservation.
    await expect(checkInPromise).rejects.toThrow(InvalidReservationTransitionError);

    const row = await testDb
      .selectFrom('reservations')
      .select('status')
      .where('id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('cancelled'); // never resurrected to checked_in

    const nights = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .execute();
    expect(nights).toHaveLength(0);
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

describe('POST /panel/reservations/:code/cancel', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'POST', url: '/panel/reservations/NOPE/cancel', payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it('404 when the reservation code does not exist', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/NOPE/cancel',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it('confirmed -> cancelled, releases reservation_nights, sets cancelled_at/by/reason', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const unitId = await insertUnit(roomId);
    const reservation = await insertReservation({ roomId, status: 'confirmed' });
    await insertNights(reservation.id, unitId, '2026-09-01', '2026-09-03');
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/cancel`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { reason: 'guest changed plans' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'cancelled' });

    const row = await testDb
      .selectFrom('reservations')
      .select(['status', 'cancelled_at', 'cancelled_by', 'cancel_reason'])
      .where('id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('cancelled');
    expect(row.cancelled_at).not.toBeNull();
    expect(row.cancelled_by).not.toBeNull();
    expect(row.cancel_reason).toBe('guest changed plans');

    const nights = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .execute();
    expect(nights).toHaveLength(0);
  });

  it('pending_payment -> cancelled is also valid (§ 8)', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, status: 'pending_payment' });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/cancel`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
  });

  it('409 INVALID_TRANSITION when checked_in — cannot cancel a guest already inside (§ 3)', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const unitId = await insertUnit(roomId);
    const reservation = await insertReservation({ roomId, status: 'checked_in' });
    await insertNights(reservation.id, unitId, '2026-09-01', '2026-09-03');
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/cancel`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('INVALID_TRANSITION');

    const nights = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .execute();
    expect(nights).toHaveLength(2); // untouched
  });
});

describe('POST /panel/reservations/:code/no-show', () => {
  it('confirmed -> no_show, releases reservation_nights, sets no_show_at/by', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const unitId = await insertUnit(roomId);
    const reservation = await insertReservation({ roomId, status: 'confirmed' });
    await insertNights(reservation.id, unitId, '2026-09-01', '2026-09-03');
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/no-show`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'no_show' });

    const row = await testDb
      .selectFrom('reservations')
      .select(['status', 'no_show_at', 'no_show_by'])
      .where('id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('no_show');
    expect(row.no_show_at).not.toBeNull();
    expect(row.no_show_by).not.toBeNull();

    const nights = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .execute();
    expect(nights).toHaveLength(0);
  });

  it('409 INVALID_TRANSITION from pending_payment (§ 8: no-show only from confirmed)', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, status: 'pending_payment' });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/no-show`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('INVALID_TRANSITION');
  });

  it('409 INVALID_TRANSITION when checked_in (§ 3)', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, status: 'checked_in' });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/no-show`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('INVALID_TRANSITION');
  });
});

describe('POST /panel/reservations/:code/extra', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/NOPE/extra',
      payload: { concept: 'Laundry', amount_cents: 1000 },
    });
    expect(response.statusCode).toBe(401);
  });

  it('inserts the extra and bumps total_cents in the same call', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, status: 'checked_in', totalCents: 20000 });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/extra`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { concept: 'Late check-out', amount_cents: 3000 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ extra_id: expect.any(Number), total_cents: 23000 });

    const row = await testDb
      .selectFrom('reservations')
      .select('total_cents')
      .where('id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(row.total_cents).toBe(23000);

    const extraRow = await testDb
      .selectFrom('reservation_extras')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(extraRow.concept).toBe('Late check-out');
    expect(extraRow.amount_cents).toBe(3000);
    expect(extraRow.created_by).not.toBeNull();
  });

  it('409 RESERVATION_NOT_PAYABLE when cancelled — nothing left to charge', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, status: 'cancelled', totalCents: 20000 });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/extra`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { concept: 'Late check-out', amount_cents: 3000 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('RESERVATION_NOT_PAYABLE');

    const row = await testDb
      .selectFrom('reservations')
      .select('total_cents')
      .where('id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(row.total_cents).toBe(20000); // untouched
  });

  it('two concurrent extras on the same reservation both land — total_cents reflects both, never overwrites one with the other', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom();
    const reservation = await insertReservation({ roomId, status: 'checked_in', totalCents: 20000 });
    const app = buildApp();

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/panel/reservations/${reservation.code}/extra`,
        cookies: { [SESSION_COOKIE_NAME]: token },
        payload: { concept: 'Laundry', amount_cents: 1000 },
      }),
      app.inject({
        method: 'POST',
        url: `/panel/reservations/${reservation.code}/extra`,
        cookies: { [SESSION_COOKIE_NAME]: token },
        payload: { concept: 'Minibar', amount_cents: 2000 },
      }),
    ]);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);

    const row = await testDb
      .selectFrom('reservations')
      .select('total_cents')
      .where('id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(row.total_cents).toBe(23000);

    const extras = await testDb
      .selectFrom('reservation_extras')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .execute();
    expect(extras).toHaveLength(2);
  });
});
