/**
 * Risk-review finding on fix-asaas-overpayment-webhook (the fix's OWN
 * cleanup step reopened the class of bug it exists to close): reconciling a
 * stale pending Asaas payment used to be a bare `UPDATE ... SET
 * status='received'`, bypassing both the reservation confirmation state
 * machine (a stale DEPOSIT never confirmed the reservation) and the
 * overpayment-flag check (ANY kind marked received here skipped
 * flagged_overpayment entirely). Both are closed by routing through
 * `processPaymentReceived` — the same function the real webhook uses.
 */
import { sql } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb, testPool } from '../../db/testClient.js';

const getPayment = vi.fn();

vi.mock('../../asaasClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../asaasClient.js')>();
  return {
    ...actual,
    getPayment: (...args: unknown[]) => getPayment(...args),
  };
});

const { assertNotOverpayingWithPendingAsaas, reconcileStalePendingAsaas } = await import('../overpaymentGuard.js');

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE payments, reservation_nights, reservations, room_units, rooms RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

async function insertTestRoom(totalUnits = 1): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({ name: 'TestRoom', capacity: 2, pets_allowed: false, default_min_stay: 1, total_units: totalUnits })
    .returning('id')
    .executeTakeFirstOrThrow();

  await testDb
    .insertInto('room_units')
    .values(Array.from({ length: totalUnits }, (_, i) => ({ room_id: room.id, label: `${room.id}-${i + 1}` })))
    .execute();

  return room.id;
}

interface ReservationFixtureOptions {
  roomId: number;
  status?: string;
  totalCents?: number;
}

async function insertReservation(options: ReservationFixtureOptions): Promise<number> {
  const reservation = await testDb
    .insertInto('reservations')
    .values({
      room_id: options.roomId,
      check_in: '2026-09-01',
      check_out: '2026-09-03',
      guests: 2,
      status: options.status ?? 'pending_payment',
      total_cents: options.totalCents ?? 20000,
      deposit_cents: 10000,
      code: 'TESTCODE',
      expires_at: new Date(Date.now() + 30 * 60 * 1000),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return reservation.id;
}

const STALE_CREATED_AT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

async function insertStalePendingPayment(
  reservationId: number,
  asaasPaymentId: string,
  kind: string,
  amountCents: number,
): Promise<void> {
  await testDb
    .insertInto('payments')
    .values({
      reservation_id: reservationId,
      asaas_payment_id: asaasPaymentId,
      method: 'asaas_pix',
      kind,
      amount_cents: amountCents,
      status: 'pending',
      created_at: STALE_CREATED_AT,
    })
    .execute();
}

beforeEach(async () => {
  await resetDb();
  getPayment.mockReset();
});

describe('reconcileStalePendingAsaas — routes RECEIVED-like rows through processPaymentReceived', () => {
  // The invariant this test locks down is protected TODAY by an accident of
  // the call graph, not by overpaymentGuard.ts itself: the panel blocks
  // `pending_payment` reservations outright (NOT_PAYABLE_STATUSES), and the
  // public endpoint only ever requests kind='deposit', so a same-kind stale
  // row always gets caught by createOrReuseAsaasPayment's own "existing"
  // lookup before reconciliation ever runs. This test calls the guard
  // directly, bypassing both of those gates, so it keeps proving the
  // invariant even if NOT_PAYABLE_STATUSES is ever relaxed or a second kind
  // becomes chargeable before confirmation.
  it('a stale pending DEPOSIT that Asaas actually received confirms the reservation and restores its nights — not left pending_payment with money already received', async () => {
    const roomId = await insertTestRoom(1);
    const reservationId = await insertReservation({ roomId, status: 'pending_payment' });
    await insertStalePendingPayment(reservationId, 'pay_stale_deposit', 'deposit', 10000);
    getPayment.mockResolvedValue({ id: 'pay_stale_deposit', status: 'RECEIVED', invoiceUrl: 'https://asaas.test/inv/stale' });

    await testDb.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${reservationId})`.execute(trx);
      await assertNotOverpayingWithPendingAsaas(trx, reservationId, 0);
    });

    const payment = await testDb
      .selectFrom('payments')
      .select('status')
      .where('asaas_payment_id', '=', 'pay_stale_deposit')
      .executeTakeFirstOrThrow();
    expect(payment.status).toBe('received');

    const reservation = await testDb
      .selectFrom('reservations')
      .select(['status', 'room_unit_id'])
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();
    expect(reservation.status).toBe('confirmed');
    expect(reservation.room_unit_id).not.toBeNull();

    const nights = await testDb
      .selectFrom('reservation_nights')
      .select('night')
      .where('reservation_id', '=', reservationId)
      .execute();
    expect(nights).toHaveLength(2); // 2026-09-01 -> 2026-09-03, checkout night excluded
  });

  // The always-reachable case, independent of any gate: a reservation
  // that's already confirmed, with a stale pending BALANCE payment Asaas
  // actually collected. No confirmation transition is needed here — the
  // point is that the reconciled payment still goes through the SAME
  // overpayment-flag check a live webhook delivery gets, instead of the
  // bare status flip silently absorbing a real overpayment.
  it('a stale pending BALANCE payment that pushed the reservation into overpayment gets flagged when reconciled, not silently marked received', async () => {
    const roomId = await insertTestRoom(1);
    const reservationId = await insertReservation({ roomId, status: 'confirmed', totalCents: 20000 });

    // Deposit already covers the full total.
    await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservationId,
        asaas_payment_id: 'pay_deposit_full',
        method: 'asaas_pix',
        kind: 'deposit',
        amount_cents: 20000,
        status: 'received',
      })
      .execute();

    await insertStalePendingPayment(reservationId, 'pay_stale_balance', 'balance', 10000);
    getPayment.mockResolvedValue({ id: 'pay_stale_balance', status: 'CONFIRMED', invoiceUrl: 'https://asaas.test/inv/stale-balance' });

    await testDb.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${reservationId})`.execute(trx);
      await reconcileStalePendingAsaas(trx, reservationId);
    });

    const payment = await testDb
      .selectFrom('payments')
      .select(['status', 'flagged_overpayment', 'flagged_overpayment_excess_cents'])
      .where('asaas_payment_id', '=', 'pay_stale_balance')
      .executeTakeFirstOrThrow();
    expect(payment.status).toBe('received');
    expect(payment.flagged_overpayment).toBe(true);
    expect(payment.flagged_overpayment_excess_cents).toBe(10000);

    const reservation = await testDb
      .selectFrom('reservations')
      .select('status')
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();
    expect(reservation.status).toBe('confirmed'); // untouched — already settled
  });

  // Verifies the mechanism, not just the outcome: while the outer
  // transaction is still open, a completely separate connection (testPool,
  // not trx) must NOT see the reconciled row as 'received' yet — only after
  // the outer transaction commits. This confirms reconciliation's writes are
  // part of the SAME atomic unit as the caller's, via Postgres MVCC
  // visibility, not timing.
  //
  // HONEST LIMIT on what removing `db.isTransaction` proves (found during a
  // risk-review's mandatory "remove the guard, confirm the test fails"
  // check): doing so does NOT reproduce the visibility leak this test
  // guards against. `trx` here is already a `Transaction`, and Kysely
  // itself refuses `trx.transaction()` on an already-open transaction — it
  // throws `"calling the transaction method for a Transaction is not
  // supported"` before reconciliation ever runs on a second connection. So
  // that removal turns this test red for a real reason (the code would
  // crash), but not for the reason this test's assertion is written to
  // catch — the crash happens before the assertion is ever reached. The
  // MVCC assertion above is still a genuine, meaningful check of normal
  // behavior (this test would catch a REAL leak if one were introduced some
  // other way, e.g. reconciliation opening a query against a raw pool
  // connection instead of `trx`) — it just isn't reachable by deleting the
  // `isTransaction` branch, because Kysely's own runtime guard against
  // nested transactions forecloses that specific path first.
  it('reconciliation reuses the caller\'s own transaction — not visible to another connection until the caller commits', async () => {
    const roomId = await insertTestRoom(1);
    const reservationId = await insertReservation({ roomId, status: 'pending_payment' });
    await insertStalePendingPayment(reservationId, 'pay_visibility', 'deposit', 10000);
    getPayment.mockResolvedValue({ id: 'pay_visibility', status: 'RECEIVED', invoiceUrl: 'https://asaas.test/inv/visibility' });

    let statusDuringOuterTransaction: string | undefined;

    await testDb.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${reservationId})`.execute(trx);
      await assertNotOverpayingWithPendingAsaas(trx, reservationId, 0);

      const { rows } = await testPool.query<{ status: string }>('SELECT status FROM payments WHERE asaas_payment_id = $1', [
        'pay_visibility',
      ]);
      statusDuringOuterTransaction = rows[0]?.status;
    });

    expect(statusDuringOuterTransaction).toBe('pending');

    const afterCommit = await testDb
      .selectFrom('payments')
      .select('status')
      .where('asaas_payment_id', '=', 'pay_visibility')
      .executeTakeFirstOrThrow();
    expect(afterCommit.status).toBe('received');
  });
});
