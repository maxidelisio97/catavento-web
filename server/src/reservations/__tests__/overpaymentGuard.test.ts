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
const createOrder = vi.fn();
const getOrder = vi.fn();

vi.mock('../../asaasClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../asaasClient.js')>();
  return {
    ...actual,
    getPayment: (...args: unknown[]) => getPayment(...args),
  };
});

vi.mock('../../pagarmeClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../pagarmeClient.js')>();
  return {
    ...actual,
    createOrder: (...args: unknown[]) => createOrder(...args),
    getOrder: (...args: unknown[]) => getOrder(...args),
  };
});

// Side-effect imports: both adapters self-register via registerProvider() at
// module load (provider.ts's registry) — overpaymentGuard.ts's per-row
// dispatch (getProvider(row.provider)) needs both registered, same as it
// would be in production via index.ts.
await import('../../payments/asaasAdapter.js');
await import('../../payments/pagarmeAdapter.js');

const { assertNotOverpayingWithPendingProvider, reconcileStalePendingProviderPayments } = await import('../overpaymentGuard.js');

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
  code?: string;
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
      code: options.code ?? 'TESTCODE',
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
      provider: 'asaas',
      provider_payment_id: asaasPaymentId,
      method: 'asaas_pix',
      kind,
      amount_cents: amountCents,
      status: 'pending',
      created_at: STALE_CREATED_AT,
    })
    .execute();
}

async function insertStalePendingPagarmePayment(
  reservationId: number,
  providerPaymentId: string,
  kind: string,
  amountCents: number,
): Promise<void> {
  await testDb
    .insertInto('payments')
    .values({
      reservation_id: reservationId,
      asaas_payment_id: null,
      provider: 'pagarme',
      provider_payment_id: providerPaymentId,
      method: 'pagarme_pix',
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
  createOrder.mockReset();
  getOrder.mockReset();
});

describe('sdd/asaas-pagarme-migration PR 4 (task A12) — the fixed danger site: provider IS NOT NULL, not a method allow-list', () => {
  // THE test that proves the fix: a pending Pagar.me row must be counted
  // against the balance even though nothing here ever names
  // 'pagarme_pix'/'pagarme_card' in a filter — if this regressed back to
  // `.where('method', 'in', ['asaas_pix', 'asaas_card'])`, this pending
  // pagarme_pix row would be invisible to the guard and the overpaying
  // second charge below would be wrongly ALLOWED (422 would never fire).
  it('a pending Pagar.me payment counts toward the balance — a same-day overpaying second charge (any provider) is rejected', async () => {
    const roomId = await insertTestRoom(1);
    const reservationId = await insertReservation({ roomId, totalCents: 20000 });

    // Pending Pagar.me deposit created TODAY (not stale — reconciliation
    // never touches it, it must still count via the balance query itself).
    await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservationId,
        asaas_payment_id: null,
        provider: 'pagarme',
        provider_payment_id: 'or_pending_1',
        method: 'pagarme_pix',
        kind: 'deposit',
        amount_cents: 15000,
        status: 'pending',
      })
      .execute();

    // A second charge (any kind/provider) for 10000 would push total pending
    // to 25000, over the 20000 balance — must be rejected.
    await expect(
      testDb.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(${reservationId})`.execute(trx);
        await assertNotOverpayingWithPendingProvider(trx, reservationId, 10000);
      }),
    ).rejects.toThrow('exceeds balance due');

    expect(getPayment).not.toHaveBeenCalled();
    expect(getOrder).not.toHaveBeenCalled();
  });

  // Per-row dispatch: a stale pending Pagar.me row is reconciled via
  // pagarmeAdapter (getOrder), a stale pending Asaas row in the SAME
  // reservation is reconciled via asaasAdapter (getPayment) — proving the
  // drain guarantee (design decision A2/A3) holds even when the guard
  // processes both providers' rows in the same pass.
  it('reconciles a mixed-provider pair of stale pending rows — each dispatched to its OWN adapter, both confirmed as received', async () => {
    // Two SEPARATE reservations, not one: idx_payments_one_pending_per_reservation
    // (migration 1784587500000) forbids two simultaneously-pending payments
    // for the SAME reservation regardless of kind, so a same-reservation
    // mixed-provider pending pair isn't a reachable DB state to fixture
    // directly — the drain scenario this design guarantee actually protects
    // (design A2/A3: in-flight Asaas rows keep resolving against Asaas
    // during a provider drain) is inherently cross-reservation anyway (rows
    // created under the OLD provider before cutover vs. rows created under
    // the NEW one after). Per-row dispatch is what's under test, not
    // same-reservation coexistence.
    const roomId = await insertTestRoom(1);
    const asaasReservationId = await insertReservation({ roomId, status: 'confirmed', totalCents: 5000, code: 'MIXEDASAAS' });
    const pagarmeReservationId = await insertReservation({ roomId, status: 'confirmed', totalCents: 5000, code: 'MIXEDPAGARME' });

    await insertStalePendingPayment(asaasReservationId, 'pay_stale_asaas', 'extra', 5000);
    await insertStalePendingPagarmePayment(pagarmeReservationId, 'or_stale_pagarme', 'extra', 5000);

    getPayment.mockResolvedValue({ id: 'pay_stale_asaas', status: 'RECEIVED', invoiceUrl: 'https://asaas.test/inv/stale' });
    getOrder.mockResolvedValue({ id: 'or_stale_pagarme', status: 'paid', charges: [] });

    await testDb.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${asaasReservationId})`.execute(trx);
      await reconcileStalePendingProviderPayments(trx, asaasReservationId);
    });
    await testDb.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${pagarmeReservationId})`.execute(trx);
      await reconcileStalePendingProviderPayments(trx, pagarmeReservationId);
    });

    expect(getPayment).toHaveBeenCalledWith('pay_stale_asaas');
    expect(getOrder).toHaveBeenCalledWith('or_stale_pagarme');
    // Cross-check dispatch never crosses wires: the Asaas row was never
    // looked up via the Pagar.me client, and vice versa.
    expect(getOrder).not.toHaveBeenCalledWith('pay_stale_asaas');
    expect(getPayment).not.toHaveBeenCalledWith('or_stale_pagarme');

    const asaasRow = await testDb
      .selectFrom('payments')
      .select('status')
      .where('provider_payment_id', '=', 'pay_stale_asaas')
      .executeTakeFirstOrThrow();
    expect(asaasRow.status).toBe('received');

    const pagarmeRow = await testDb
      .selectFrom('payments')
      .select('status')
      .where('provider_payment_id', '=', 'or_stale_pagarme')
      .executeTakeFirstOrThrow();
    expect(pagarmeRow.status).toBe('received');
  });
});

describe('reconcileStalePendingProviderPayments — routes RECEIVED-like rows through processPaymentReceived', () => {
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
      await assertNotOverpayingWithPendingProvider(trx, reservationId, 0);
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
      await reconcileStalePendingProviderPayments(trx, reservationId);
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
      await assertNotOverpayingWithPendingProvider(trx, reservationId, 0);

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
