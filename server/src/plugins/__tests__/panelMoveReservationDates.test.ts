/**
 * Integration tests for sdd/move-reservation-dates —
 * POST /panel/reservations/:code/move-dates.
 *
 * Scope: T5-T9 (status gate, overlap, physical conflict, both price paths,
 * min-stay non-blocking warning) + T10-T11a (concurrency, PR 2 of this
 * chain) + T13 (Channex push, PR 3 of this chain).
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { Kysely, PostgresDialect, sql, type KyselyPlugin, type RootOperationNode } from 'kysely';
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb, testPool } from '../../db/testClient.js';
import type { DB } from '../../db/types.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelMoveReservationPlugin from '../panelMoveReservation.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { getDueñoRoleId } from '../../test-support/permissionFixtures.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';
import { eachNightUTC } from '../../shared/dateUtils.js';
import { createQueryStartSignal, createQueryTimingPlugin, rawSqlContains } from '../../test-support/queryBarrier.js';
import { setRoomTypeMap } from '../../channex/channexRoomTypeMap.js';
import { updateChannexConfig } from '../../channex/channexConfig.js';

// T13 (sdd/move-reservation-dates, PR 3): proves moveReservationDates fires
// TWO separate Channex pushes (old range freed + new range occupied), never
// merged into one call — mirrors pushAvailability.triggers.test.ts's mocking
// convention. Every other test in this file never configures channex_config,
// so `pushRange` short-circuits on `!channexConfig.isActive` for them — this
// mock is safe to apply file-wide.
const pushAvailabilityMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../channex/channexClient.js', () => ({
  pushAvailability: (...args: unknown[]) => pushAvailabilityMock(...args),
  pushRestrictions: vi.fn().mockResolvedValue(undefined),
}));

function buildApp(db: Kysely<DB> = testDb) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelMoveReservationPlugin, { db });
  registerErrorHandler(app);
  return app;
}

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE payments, reservation_nights, reservations, room_rates, room_units, channex_room_type_map, channex_config, rooms, sessions, users RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

async function insertRoom(
  name: string,
  options: { capacity?: number; defaultMinStay?: number } = {},
): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({
      name,
      capacity: options.capacity ?? 2,
      adults_only: false,
      pets_allowed: false,
      default_min_stay: options.defaultMinStay ?? 1,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  // Every test room needs a rate row: calculatePrice is always invoked
  // (min-stay warning check runs regardless of recalculate_price) and
  // throws if no room_rates row matches the requested occupancy.
  await testDb
    .insertInto('room_rates')
    .values({ room_id: room.id, occupancy: options.capacity ?? 2, weekday_cents: 20000, weekend_cents: 25000 })
    .execute();
  return room.id;
}

async function insertUnit(roomId: number, label: string): Promise<number> {
  const unit = await testDb
    .insertInto('room_units')
    .values({ room_id: roomId, label })
    .returning('id')
    .executeTakeFirstOrThrow();
  return unit.id;
}

interface ReservationFixtureOptions {
  roomId: number;
  checkIn: string;
  checkOut: string;
  unitId: number;
  status?: string;
  guests?: number;
  totalCents?: number;
  code?: string;
}

async function insertReservation(options: ReservationFixtureOptions): Promise<{ id: number; code: string }> {
  const nights = eachNightUTC(options.checkIn, options.checkOut);
  const code = options.code ?? `CAT-${randomBytes(4).toString('hex')}`;

  const row = await testDb
    .insertInto('reservations')
    .values({
      room_id: options.roomId,
      room_unit_id: options.unitId,
      check_in: options.checkIn,
      check_out: options.checkOut,
      guests: options.guests ?? 2,
      children: 0,
      babies: 0,
      pets: false,
      status: options.status ?? 'confirmed',
      total_cents: options.totalCents ?? 30000,
      guest_name: 'Maria Gonzalez',
      guest_email: 'maria@example.com',
      guest_phone: '+55 85 90000-0000',
      code,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  if (nights.length > 0) {
    await testDb
      .insertInto('reservation_nights')
      .values(nights.map((night) => ({ reservation_id: row.id, night, room_unit_id: options.unitId })))
      .execute();
  }

  return { id: row.id, code };
}

async function insertSessionCookie(): Promise<string> {
  const user = await testDb
    .insertInto('users')
    .values({
      email: 'owner@catavento.test',
      name: 'Maxi',
      password_hash: await hashPassword('whatever'),
      role_id: await getDueñoRoleId(testDb),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const token = randomBytes(32).toString('base64url');
  const tokenHash = (await import('node:crypto')).createHash('sha256').update(token).digest('hex');
  await testDb
    .insertInto('sessions')
    .values({ user_id: user.id, token_hash: tokenHash, expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) })
    .execute();

  return token;
}

async function nightsOf(reservationId: number): Promise<{ night: string; room_unit_id: number }[]> {
  const rows = await testDb
    .selectFrom('reservation_nights')
    .select([sql<string>`night::text`.as('night'), 'room_unit_id'])
    .where('reservation_id', '=', reservationId)
    .orderBy('night')
    .execute();
  return rows;
}

async function reservationRow(reservationId: number) {
  return testDb
    .selectFrom('reservations')
    .select([
      sql<string>`check_in::text`.as('check_in'),
      sql<string>`check_out::text`.as('check_out'),
      'total_cents',
      'status',
    ])
    .where('id', '=', reservationId)
    .executeTakeFirstOrThrow();
}

/**
 * True when a DELETE's FROM clause targets `reservation_nights` — used to
 * fingerprint `releaseReservationNights`'s DELETE inside `moveReservationDates`
 * (the only DELETE in its write path). Mirrors `selectReferencesTable`'s
 * approach (queryBarrier.ts) but for `DeleteQueryNode`, which has no
 * ready-made helper there.
 */
function isDeleteFromReservationNights(node: RootOperationNode): boolean {
  if (node.kind !== 'DeleteQueryNode') return false;
  const fromNode = (node as unknown as { from?: { froms?: { kind: string; table?: { identifier?: { name?: string } } }[] } })
    .from;
  return (fromNode?.froms ?? []).some((t) => t.kind === 'TableNode' && t.table?.identifier?.name === 'reservation_nights');
}

/**
 * Asymmetric, single-sided pause — deliberately NOT `createQueryBarrierPlugin`
 * (queryBarrier.ts). That plugin's `arity` is a rendezvous between N callers
 * that all go through the SAME instrumented Kysely instance and all release
 * together; Test B's concurrent writer is a plain, uninstrumented connection
 * (`testDb`) that must commit BEFORE the paused side is allowed to continue —
 * there's no second matched caller to pair against. Local to this file: a
 * one-off variant of the same transformQuery/transformResult convention, not
 * a general-purpose tool (see this file's Test B for why the design's literal
 * `arity: 1` doesn't actually pause — an empirically-verified deviation,
 * documented in the apply-progress writeup).
 */
function createPauseGate(match: (node: RootOperationNode) => boolean): {
  plugin: KyselyPlugin;
  reached: Promise<void>;
  release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const markedQueryIds = new Set<string>();

  const plugin: KyselyPlugin = {
    transformQuery(args) {
      if (match(args.node)) markedQueryIds.add(args.queryId.queryId);
      return args.node;
    },
    async transformResult(args) {
      const id = args.queryId.queryId;
      if (markedQueryIds.has(id)) {
        markedQueryIds.delete(id);
        markReached();
        await gate;
      }
      return args.result;
    },
  };

  return { plugin, reached, release };
}

beforeEach(async () => {
  await resetDb();
  pushAvailabilityMock.mockClear();
});

describe('POST /panel/reservations/:code/move-dates', () => {
  it('past-dated confirmed reservation keeps full-range edit rights (no date-vs-today comparison)', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unit = await insertUnit(roomId, 'A1');
    const reservation = await insertReservation({
      roomId,
      checkIn: '2020-01-01', // deliberately far in the past
      checkOut: '2020-01-03',
      unitId: unit,
      status: 'confirmed',
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-11-01', check_out: '2026-11-03', recalculate_price: false },
    });

    expect(response.statusCode).toBe(200);
    const row = await reservationRow(reservation.id);
    expect(row.check_in).toBe('2026-11-01');
    expect(row.check_out).toBe('2026-11-03');
    expect(await nightsOf(reservation.id)).toEqual([
      { night: '2026-11-01', room_unit_id: unit },
      { night: '2026-11-02', room_unit_id: unit },
    ]);
  });

  it('409 RESERVATION_NOT_MOVABLE when the reservation is checked_in — excluded entirely, not just check_in-locked', async () => {
    // Owner decision (post-PR-1): checked_in is NOT eligible for move-dates
    // at all. The overlap rule always rejects a request that keeps check_in
    // fixed, so a "check_out only" carve-out for checked_in would have been
    // unreachable dead code — a checked_in guest's date change is really
    // "extend/shorten stay", an explicit non-goal of this feature (future
    // "Estender estadia"). Covers both a check_in change AND a check_out-only
    // change — both must be rejected the same way, before ever reaching the
    // overlap check.
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unit = await insertUnit(roomId, 'B1');
    const reservation = await insertReservation({
      roomId,
      checkIn: '2026-10-01',
      checkOut: '2026-10-03',
      unitId: unit,
      status: 'checked_in',
    });
    const app = buildApp();

    const changingCheckIn = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-10-02', check_out: '2026-10-04', recalculate_price: false },
    });
    expect(changingCheckIn.statusCode).toBe(409);
    expect(changingCheckIn.json().error).toBe('RESERVATION_NOT_MOVABLE');

    const checkOutOnly = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-10-01', check_out: '2026-10-06', recalculate_price: false },
    });
    expect(checkOutOnly.statusCode).toBe(409);
    expect(checkOutOnly.json().error).toBe('RESERVATION_NOT_MOVABLE');

    expect(await nightsOf(reservation.id)).toEqual([
      { night: '2026-10-01', room_unit_id: unit },
      { night: '2026-10-02', room_unit_id: unit },
    ]);
  });

  it('400 DATE_RANGE_OVERLAPS_CURRENT when the requested range overlaps the current range; nothing written', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unit = await insertUnit(roomId, 'C1');
    const reservation = await insertReservation({
      roomId,
      checkIn: '2026-10-01',
      checkOut: '2026-10-05',
      unitId: unit,
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-10-03', check_out: '2026-10-08', recalculate_price: false },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('DATE_RANGE_OVERLAPS_CURRENT');
    const row = await reservationRow(reservation.id);
    expect(row.check_in).toBe('2026-10-01');
    expect(row.check_out).toBe('2026-10-05');
    expect(await nightsOf(reservation.id)).toHaveLength(4);
  });

  it('409 PHYSICAL_CONFLICT when the unit is occupied in the new range; zero reservation_nights rows inserted or deleted', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unit = await insertUnit(roomId, 'D1');
    const mover = await insertReservation({
      roomId,
      checkIn: '2026-11-01',
      checkOut: '2026-11-03',
      unitId: unit,
    });
    // Occupies the SAME unit for part of the requested new range.
    await insertReservation({
      roomId,
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      unitId: unit,
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${mover.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-11-10', check_out: '2026-11-14', recalculate_price: false },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('PHYSICAL_CONFLICT');

    // Mover's original nights untouched (rolled back, never partially written).
    expect(await nightsOf(mover.id)).toEqual([
      { night: '2026-11-01', room_unit_id: unit },
      { night: '2026-11-02', room_unit_id: unit },
    ]);
    const row = await reservationRow(mover.id);
    expect(row.check_in).toBe('2026-11-01');
    expect(row.check_out).toBe('2026-11-03');
  });

  it('recalculate_price: true updates total_cents to the new-date rate; false leaves it unchanged', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unit = await insertUnit(roomId, 'E1');

    const keepPrice = await insertReservation({
      roomId,
      checkIn: '2026-10-01',
      checkOut: '2026-10-03',
      unitId: unit,
      totalCents: 30000,
    });
    const app = buildApp();

    const kept = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${keepPrice.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-10-15', check_out: '2026-10-17', recalculate_price: false },
    });
    expect(kept.statusCode).toBe(200);
    expect((await reservationRow(keepPrice.id)).total_cents).toBe(30000);

    const recalcUnit = await insertUnit(roomId, 'E2');
    const recalcMove = await insertReservation({
      roomId,
      checkIn: '2026-10-01',
      checkOut: '2026-10-03',
      unitId: recalcUnit,
      totalCents: 30000,
    });
    const recalculated = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${recalcMove.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-10-20', check_out: '2026-10-22', recalculate_price: true },
    });
    expect(recalculated.statusCode).toBe(200);
    // 2 weekday nights @ 20000 = 40000 (weekday rate fixture; exact weekday
    // split isn't asserted, only that it now differs from the frozen price).
    const updated = await reservationRow(recalcMove.id);
    expect(updated.total_cents).not.toBe(30000);
    expect(updated.total_cents).toBeGreaterThan(0);
  });

  it('below-min-stay new range succeeds with a non-blocking BELOW_MIN_STAY warning', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal', { defaultMinStay: 3 });
    const unit = await insertUnit(roomId, 'F1');
    const reservation = await insertReservation({
      roomId,
      checkIn: '2026-10-01',
      checkOut: '2026-10-04', // 3 nights, satisfies min-stay
      unitId: unit,
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-11-01', check_out: '2026-11-03', recalculate_price: false }, // 2 nights, below min-stay 3
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().warnings).toEqual([{ code: 'BELOW_MIN_STAY', message: expect.any(String) }]);
    const row = await reservationRow(reservation.id);
    expect(row.check_in).toBe('2026-11-01');
    expect(row.check_out).toBe('2026-11-03');
    expect(await nightsOf(reservation.id)).toHaveLength(2);
  });
});

describe('concurrency: move-dates and move-night on the SAME reservation share the SAME advisory-lock key (T10)', () => {
  // Design (sdd/move-reservation-dates § "2. reservation_nights_..._unique",
  // Test A): a real two-endpoint Promise.all race. moveReservationDates and
  // moveNight both take `pg_advisory_xact_lock(reservationId)` as the first
  // statement inside their own transaction — same key, same codebase-wide
  // lock order (see moveReservationDates.ts's and moveReservation.ts's
  // module doc comments) — so Postgres itself fully serializes them.
  //
  // TWO VERIFIED, DOCUMENTED DEVIATIONS from the design's literal Test A:
  //
  // (1) The design's example races moveDates(R:[10,13) -> [11,14)) against
  // moveNight(night 11). [11,14) INTERSECTS [10,13) (shares nights 11-12) —
  // the overlap rule (this same design's own Architecture Decisions table)
  // rejects ANY new range that intersects the current one with a 400,
  // BEFORE the lock is ever taken. That 400 is a real, confirmed outcome
  // (reproduced while writing this test), not a hypothetical — the design's
  // own example can never reach the lock as written. Fixed by moving to a
  // range that doesn't intersect the current one at all: [20,23).
  // `releaseReservationNights` deletes ALL of the reservation's rows
  // unconditionally (not just a delta), so moveNight's target night is still
  // fully in play regardless of which new range is chosen.
  //
  // (2) Given (1), night 11 can never survive in BOTH the pre-move and
  // post-move state at once (the two ranges are now provably disjoint) — so
  // the two orderings of a genuinely uncontrolled Promise.all are NOT
  // equally valid: if moveDates commits FIRST, moveNight's later write
  // becomes a night the reservation's CURRENT range no longer contains, and
  // `assertReservationNightsConsistency` (a real, existing invariant this
  // change does not touch) legitimately rejects it inside moveNight's own
  // transaction (row count no longer matches `check_out - check_in`) — a
  // correct outcome given moveNight (unmodified in this PR) never re-checks
  // the night is still in-range post-lock, but NOT what "both 200" should
  // assert, and NOT the class of bug this test exists to catch. A bare,
  // uncontrolled `Promise.all` here would be genuinely racy on WHICH of the
  // two orderings happens — exactly the failure mode server/CLAUDE.md's
  // concurrency-test section requires a rendezvous for, not chance. Fixed by
  // sequencing the two real requests deterministically with
  // `createQueryStartSignal` on the SHARED `pg_advisory_xact_lock` raw SQL:
  // moveNight's request is dispatched first and awaited only up to "its lock
  // query has been sent" (not full completion) before moveDates's request is
  // dispatched — guaranteeing moveNight always wins the race for the lock,
  // the one ordering that is actually self-consistent, while moveDates is
  // still genuinely blocked on a REAL, contended advisory lock (proven via
  // `createQueryTimingPlugin` on the same raw SQL) for the entire time
  // moveNight's transaction remains open.
  it('DETERMINISTIC: moveNight (winning the lock race) commits first, moveDates blocks on the SAME lock and then overwrites cleanly — both 200, final state consistent', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unitA = await insertUnit(roomId, 'H1');
    const unitB = await insertUnit(roomId, 'H2');
    const reservation = await insertReservation({
      roomId,
      checkIn: '2026-11-10',
      checkOut: '2026-11-13', // nights 10, 11, 12
      unitId: unitA,
    });

    // moveNight's db: resolves `moveNightLockSent` as soon as ITS
    // pg_advisory_xact_lock query is dispatched — the rendezvous point that
    // lets the test dispatch moveDates only once moveNight is guaranteed to
    // have already claimed the lock.
    const { plugin: startSignalPlugin, started: moveNightLockSent } = createQueryStartSignal({
      match: (node) => rawSqlContains(node, 'pg_advisory_xact_lock'),
    });
    const moveNightDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: testPool }), plugins: [startSignalPlugin] });
    const moveNightApp = buildApp(moveNightDb);

    // moveDates's db: records how long ITS OWN lock-acquisition call takes —
    // proof that it genuinely waited on the contended lock, not that it just
    // happened to run after moveNight for unrelated reasons.
    const { plugin: timingPlugin, timings: moveDatesLockTimings } = createQueryTimingPlugin({
      match: (node) => rawSqlContains(node, 'pg_advisory_xact_lock'),
    });
    const moveDatesDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: testPool }), plugins: [timingPlugin] });
    const moveDatesApp = buildApp(moveDatesDb);

    const moveNightPromise = moveNightApp.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-night`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { night: '2026-11-11', toUnitId: unitB },
    });
    moveNightPromise.catch(() => {});

    // Guarantees moveNight has already sent its lock-acquisition query
    // before moveDates's request is even dispatched — moveNight wins the
    // race for the lock deterministically, every run.
    await moveNightLockSent;

    const moveDatesPromise = moveDatesApp.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-11-20', check_out: '2026-11-23', recalculate_price: false }, // nights 20, 21, 22
    });

    const [moveNightResponse, moveDatesResponse] = await Promise.all([moveNightPromise, moveDatesPromise]);

    expect(moveNightResponse.statusCode).toBe(200);
    expect(moveDatesResponse.statusCode).toBe(200);

    // moveDates's lock query actually blocked waiting for moveNight's
    // transaction to release it — not a coincidence of ordering.
    expect(moveDatesLockTimings).toHaveLength(1);
    expect(moveDatesLockTimings[0]!.durationMs).toBeGreaterThan(0);

    // moveDates fully replaces the reservation's rows (reusing its existing
    // unit), so moveNight's earlier change is cleanly overwritten, never
    // left as a stray/orphaned row — the final state matches ONLY the new
    // range, one row per night, no duplicates or gaps.
    const finalRow = await reservationRow(reservation.id);
    const finalNights = await nightsOf(reservation.id);
    expect(finalRow.check_in).toBe('2026-11-20');
    expect(finalRow.check_out).toBe('2026-11-23');
    expect(finalNights).toEqual([
      { night: '2026-11-20', room_unit_id: unitA },
      { night: '2026-11-21', room_unit_id: unitA },
      { night: '2026-11-22', room_unit_id: unitA },
    ]);
  }, 15000);
});

describe('concurrency: constraint translation for a concurrent (reservation_id, night) write (T11)', () => {
  // Design (Test B), WITH TWO VERIFIED, DOCUMENTED DEVIATIONS from its
  // literal text — see below for why.
  //
  // (1) Same overlap-rule finding as Test A above: the design's example
  // moves [10,13) -> [11,14), which intersects the current range and is
  // rejected with 400 before the lock/DELETE are ever reached (reproduced
  // while writing this test — the first version of it hung until timeout
  // because `reached` never resolved: the request never got past the
  // overlap check). Fixed the same way as Test A: a genuinely
  // non-overlapping new range, [20,23).
  //
  // (2) The design's concurrent writer targets night 11 — a night in BOTH
  // the OLD range and (in the design's now-corrected-away overlap) the new
  // one. Empirically verified (scratch probe against catavento_db_test,
  // plain Postgres UNIQUE(k) table, DELETE left uncommitted in txn1, INSERT
  // of the SAME key from txn2): a concurrent INSERT for a key an in-flight,
  // uncommitted DELETE is ALSO removing does NOT proceed uncontested —
  // Postgres's unique-index insert path calls XactLockTableWait and BLOCKS
  // the writer until the deleting transaction resolves, then re-checks. That
  // contradicts the design's "that writer is not blocked" premise for any
  // night `releaseReservationNights` is concurrently, un-committedly
  // deleting — using one would deadlock the test (it awaits the writer's
  // INSERT before calling `release()`, but that INSERT can't resolve until
  // the paused transaction is released). Fixed: target night 22 — inside the
  // NEW range only, never part of the CURRENT range, so the DELETE never
  // touches key (reservation_id, 22) and the writer's INSERT has nothing to
  // wait on. The barrier still forces genuine concurrency (the writer
  // commits WHILE moveReservationDates's transaction is open, parked between
  // its DELETE and its bulk INSERT). The underlying claim under test — a
  // concurrent write to (reservation_id, night) is caught and translated to
  // 409 CONCURRENT_MODIFICATION, not a raw 500, and NOT mistaken for
  // PHYSICAL_CONFLICT — is unaffected by which night carries it.
  it('DETERMINISTIC: a concurrent write to (reservation_id, night) mid-transaction is translated to 409 CONCURRENT_MODIFICATION, never PHYSICAL_CONFLICT or a raw 500', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unit = await insertUnit(roomId, 'J1');
    const otherUnit = await insertUnit(roomId, 'J2');
    const reservation = await insertReservation({
      roomId,
      checkIn: '2026-11-10',
      checkOut: '2026-11-13', // nights 10, 11, 12
      unitId: unit,
    });

    const { plugin: pausePlugin, reached, release } = createPauseGate(isDeleteFromReservationNights);
    const pausedDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: testPool }), plugins: [pausePlugin] });
    const app = buildApp(pausedDb);

    const responsePromise = app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      // Non-overlapping with [10,13) — see this block's deviation (1) above.
      payload: { check_in: '2026-11-20', check_out: '2026-11-23', recalculate_price: false }, // nights 20, 21, 22
    });
    // Never let this leak as an unhandled rejection if something below throws
    // before we `await responsePromise` — same rationale as
    // panelMoveReservation.test.ts's advisory-lock test.
    responsePromise.catch(() => {});

    // Waits for `releaseReservationNights`'s DELETE to have returned its
    // result and parked — moveReservationDates is now suspended between the
    // DELETE and its bulk INSERT, mid-transaction, uncommitted.
    await reached;

    // Concurrent writer, on a completely separate, uninstrumented connection
    // (testDb): (reservation_id: R, night: 22, room_unit_id: otherUnit) —
    // (otherUnit, 22) is free, so `unit_night` structurally CANNOT be the
    // constraint that fires later; only `reservation_nights_reservation_night_unique`
    // can. Not blocked (see deviation (2) above): night 22 was never one of
    // R's rows, so the paused DELETE holds nothing this key depends on.
    await testDb
      .insertInto('reservation_nights')
      .values({ reservation_id: reservation.id, night: '2026-11-22', room_unit_id: otherUnit })
      .execute();

    release();
    const response = await responsePromise;

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('CONCURRENT_MODIFICATION');

    // moveReservationDates's transaction rolled back entirely (atomic) — the
    // reservation's original range is untouched, its 3 original rows are
    // intact, and the writer's independently-committed row (same
    // reservation_id, different unit) is the only addition — never a
    // duplicate, never touched by the rollback (separate connection/txn).
    const row = await reservationRow(reservation.id);
    expect(row.check_in).toBe('2026-11-10');
    expect(row.check_out).toBe('2026-11-13');
    expect(await nightsOf(reservation.id)).toEqual([
      { night: '2026-11-10', room_unit_id: unit },
      { night: '2026-11-11', room_unit_id: unit },
      { night: '2026-11-12', room_unit_id: unit },
      { night: '2026-11-22', room_unit_id: otherUnit },
    ]);
  }, 15000);
});

describe('Channex sync: moveReservationDates pushes both the freed OLD range and the occupied NEW range (T13)', () => {
  const ROOM_TYPE_ID = '7f1fe757-cf66-4878-82fe-ae25920e8d1f';

  it('fires two separate pushAvailability calls, one per range, never merged', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal');
    const unit = await insertUnit(roomId, 'K1');
    await updateChannexConfig(testDb, { propertyId: 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f', isActive: true });
    await setRoomTypeMap(testDb, { roomId, channexRoomTypeId: ROOM_TYPE_ID, channexRatePlanId: null });

    const reservation = await insertReservation({
      roomId,
      checkIn: '2026-11-10',
      checkOut: '2026-11-13', // OLD range: nights 10, 11, 12
      unitId: unit,
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/panel/reservations/${reservation.code}/move-dates`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { check_in: '2026-11-20', check_out: '2026-11-23', recalculate_price: false }, // NEW range: nights 20, 21, 22
    });

    expect(response.statusCode).toBe(200);

    // schedulePushAvailability is fire-and-forget (never awaited by
    // moveReservationDates itself) — vi.waitFor proves both pushes were
    // genuinely attempted, not that they merely could have been.
    await vi.waitFor(() => expect(pushAvailabilityMock).toHaveBeenCalledTimes(2));

    // Two calls, each carrying exactly its own range's nights — never one
    // call covering both ranges (the two ranges aren't even contiguous:
    // [10,13) and [20,23) can't be a single push by accident).
    const calls = pushAvailabilityMock.mock.calls as [{ date: string }[]][];
    const datesPerCall = calls.map((args) => args[0].map((v) => v.date).sort());
    expect(datesPerCall).toEqual(
      expect.arrayContaining([
        ['2026-11-10', '2026-11-11', '2026-11-12'],
        ['2026-11-20', '2026-11-21', '2026-11-22'],
      ]),
    );
  });
});
