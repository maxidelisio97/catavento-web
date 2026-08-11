/**
 * Integration tests for SPEC-modulo-8-configuracion.md § 6.2–6.5 —
 * GET/PUT /panel/rate-overrides, PATCH /panel/rate-overrides/range.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { Kysely, PostgresDialect, sql, type RootOperationNode } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, testPool } from '../../db/testClient.js';
import type { DB } from '../../db/types.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelRateOverridesPlugin from '../panelRateOverrides.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { createRoleWithPermissions, createSessionCookieForRole, getDueñoRoleId } from '../../test-support/permissionFixtures.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';
import { applyRateOverridesRange } from '../../panel/rateOverrides.js';
import { createQueryTimingPlugin, selectReferencesTable, waitForLockWait } from '../../test-support/queryBarrier.js';
import { addDaysUTC, formatDateUTC, parseDateUTC } from '../../shared/dateUtils.js';

function buildApp(db: Kysely<DB> = testDb) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelRateOverridesPlugin, { db });
  registerErrorHandler(app);
  return app;
}

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE reservation_nights, reservations, rate_overrides, room_units, room_rates, rooms, users, sessions RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

async function insertRoom(name: string): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({ name, capacity: 2, adults_only: false, pets_allowed: false, default_min_stay: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();

  await testDb
    .insertInto('room_rates')
    .values({ room_id: room.id, occupancy: 2, weekday_cents: 10000, weekend_cents: 15000 })
    .execute();

  return room.id;
}

async function insertUnit(roomId: number, label: string): Promise<number> {
  const unit = await testDb.insertInto('room_units').values({ room_id: roomId, label }).returning('id').executeTakeFirstOrThrow();
  return unit.id;
}

/** Directly inserts a confirmed reservation occupying one unit for [checkIn, checkOut) — bypasses createReservation for simple occupancy fixtures. */
async function insertOccupyingReservation(roomId: number, checkIn: string, checkOut: string): Promise<number> {
  const reservation = await testDb
    .insertInto('reservations')
    .values({ room_id: roomId, check_in: checkIn, check_out: checkOut, guests: 2, status: 'confirmed', total_cents: 20000 })
    .returning('id')
    .executeTakeFirstOrThrow();
  return reservation.id;
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
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await testDb
    .insertInto('sessions')
    .values({ user_id: user.id, token_hash: tokenHash, expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) })
    .execute();

  return token;
}

beforeEach(async () => {
  await resetDb();
});

describe('GET /panel/rate-overrides', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/panel/rate-overrides?room_id=1&from=2026-01-01&to=2026-01-31' });
    expect(response.statusCode).toBe(401);
  });

  it('returns only rows within the range, for the requested room', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    const otherRoomId = await insertRoom('Casal');

    await testDb
      .insertInto('rate_overrides')
      .values([
        { room_id: roomId, date: '2026-01-10', price_cents: 30000 },
        { room_id: roomId, date: '2026-02-01', price_cents: 30000 }, // out of range
        { room_id: otherRoomId, date: '2026-01-10', price_cents: 40000 }, // other room
      ])
      .execute();

    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/panel/rate-overrides?room_id=${roomId}&from=2026-01-01&to=2026-01-31`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { date: '2026-01-10', price_cents: 30000, min_stay: null, closed: false, units_available: null },
    ]);
  });
});

describe('PUT /panel/rate-overrides', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      payload: { room_id: 1, date: '2026-01-10', price_cents: 30000 },
    });
    expect(response.statusCode).toBe(401);
  });

  it('creates an override touching only the sent field', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    const app = buildApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, date: '2026-01-10', price_cents: 30000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ date: '2026-01-10', price_cents: 30000, min_stay: null, closed: false, units_available: null });
  });

  it('a later PUT with a different field leaves the first field untouched', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    const app = buildApp();

    await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, date: '2026-01-10', price_cents: 30000 },
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, date: '2026-01-10', min_stay: 3 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ date: '2026-01-10', price_cents: 30000, min_stay: 3, closed: false, units_available: null });
  });

  it('an explicit null clears a field back to base without touching the others', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    const app = buildApp();

    await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, date: '2026-01-10', price_cents: 30000, min_stay: 3 },
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, date: '2026-01-10', price_cents: null },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ date: '2026-01-10', price_cents: null, min_stay: 3, closed: false, units_available: null });
  });

  it('clearing every field back to base deletes the row', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    const app = buildApp();

    await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, date: '2026-01-10', price_cents: 30000 },
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, date: '2026-01-10', price_cents: null },
    });

    expect(response.statusCode).toBe(200);
    const rows = await testDb.selectFrom('rate_overrides').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('rejects units_available below the already-occupied count for that night', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    await insertOccupyingReservation(roomId, '2026-01-10', '2026-01-12'); // occupies 01-10 and 01-11
    await insertOccupyingReservation(roomId, '2026-01-10', '2026-01-11'); // occupies 01-10 only — 2 occupied on 01-10

    const app = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, date: '2026-01-10', units_available: 1 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'UNITS_AVAILABLE_BELOW_OCCUPIED', date: '2026-01-10', occupied: 2, requested: 1 });

    const rows = await testDb.selectFrom('rate_overrides').selectAll().execute();
    expect(rows).toHaveLength(0); // rejected — no row written
  });

  it('accepts units_available exactly equal to the occupied count', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    await insertOccupyingReservation(roomId, '2026-01-10', '2026-01-11');

    const app = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, date: '2026-01-10', units_available: 1 },
    });

    expect(response.statusCode).toBe(200);
  });

  // Risk-review finding (8C, pre-merge): the guard's occupancy count relies
  // on isReservationActive treating a not-yet-expired pending_payment as
  // occupied (SPEC § 7) — this was verified by hand during the review but
  // never asserted in the suite; every other fixture here uses `confirmed`.
  it('a not-yet-expired pending_payment reservation counts as occupied for the guard', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    await testDb
      .insertInto('reservations')
      .values({
        room_id: roomId,
        check_in: '2026-01-10',
        check_out: '2026-01-11',
        guests: 2,
        status: 'pending_payment',
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
        total_cents: 10000,
      })
      .execute();

    const app = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, date: '2026-01-10', units_available: 0 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'UNITS_AVAILABLE_BELOW_OCCUPIED', date: '2026-01-10', occupied: 1, requested: 0 });
  });

  it('an EXPIRED pending_payment reservation does NOT count as occupied for the guard', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    await testDb
      .insertInto('reservations')
      .values({
        room_id: roomId,
        check_in: '2026-01-10',
        check_out: '2026-01-11',
        guests: 2,
        status: 'pending_payment',
        expires_at: new Date(Date.now() - 10 * 60 * 1000),
        total_cents: 10000,
      })
      .execute();

    const app = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, date: '2026-01-10', units_available: 0 },
    });

    expect(response.statusCode).toBe(200);
  });

  it('closed has no occupancy guard — accepted even with existing reservations', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    await insertOccupyingReservation(roomId, '2026-01-10', '2026-01-11');

    const app = buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, date: '2026-01-10', closed: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().closed).toBe(true);
  });

  // § 6.7 edge case flagged explicitly by the project owner: a night can be
  // BOTH closed and still hold old reservations (closed never de-books
  // anyone). The units_available guard applies the same way regardless —
  // occupied count is what it is, independent of the closed flag. This
  // matters because closing/reopening never resets `units_available`, so if
  // the guard were skipped while closed, reopening the night later would
  // instantly surface a cupo lower than what's actually booked.
  it('units_available guard still applies on a closed night with existing reservations', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    await insertOccupyingReservation(roomId, '2026-01-10', '2026-01-11');
    await insertOccupyingReservation(roomId, '2026-01-10', '2026-01-11');

    const app = buildApp();
    // First close the night (no guard — allowed even with 2 occupied).
    const closeResponse = await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, date: '2026-01-10', closed: true },
    });
    expect(closeResponse.statusCode).toBe(200);

    // Now try to also drop units_available below the 2 occupied — guarded
    // the same as if the night were open.
    const response = await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, date: '2026-01-10', units_available: 1 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'UNITS_AVAILABLE_BELOW_OCCUPIED', date: '2026-01-10', occupied: 2, requested: 1 });

    // closed=true from the first PUT must survive the rejected second PUT.
    const rows = await testDb.selectFrom('rate_overrides').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.closed).toBe(true);
    expect(rows[0]!.units_available).toBeNull();
  });

  it('rejects a negative price_cents', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    const app = buildApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, date: '2026-01-10', price_cents: -100 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an empty body', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    const app = buildApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, date: '2026-01-10' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('404s for a non-existent room', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/panel/rate-overrides',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: 999999, date: '2026-01-10', price_cents: 30000 },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('PATCH /panel/rate-overrides/range', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/rate-overrides/range',
      payload: { room_id: 1, from: '2026-01-01', to: '2026-01-05', price_cents: 30000 },
    });
    expect(response.statusCode).toBe(401);
  });

  it('applies price_cents to every night in the range', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/rate-overrides/range',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, from: '2026-01-01', to: '2026-01-05', price_cents: 30000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ nights: 5, price_min_stay_closed_applied: true, units_available: null });

    const rows = await testDb.selectFrom('rate_overrides').select(['price_cents']).execute();
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.price_cents === 30000)).toBe(true);
  });

  it('§ 6.5: applies units_available partially, reporting exactly which nights failed and how many reservations each has', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    // 2026-01-02 has 2 occupied, 2026-01-04 has 1 occupied; the rest have 0.
    await insertOccupyingReservation(roomId, '2026-01-02', '2026-01-03');
    await insertOccupyingReservation(roomId, '2026-01-02', '2026-01-03');
    await insertOccupyingReservation(roomId, '2026-01-04', '2026-01-05');

    const app = buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/rate-overrides/range',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, from: '2026-01-01', to: '2026-01-05', units_available: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      nights: 5,
      price_min_stay_closed_applied: false,
      units_available: {
        applied_count: 4,
        failures: [{ date: '2026-01-02', occupied: 2 }],
      },
    });

    const rows = await testDb
      .selectFrom('rate_overrides')
      .select([sql<string>`date::text`.as('date'), 'units_available'])
      .orderBy('date')
      .execute();
    // 01-02 was rejected (no row for it — never touched, occupied=2 > requested=1).
    expect(rows.map((r) => r.date)).toEqual(['2026-01-01', '2026-01-03', '2026-01-04', '2026-01-05']);
    expect(rows.every((r) => r.units_available === 1)).toBe(true);
  });

  it('a mixed patch applies price/min_stay/closed to the whole range even when units_available partially fails', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    await insertOccupyingReservation(roomId, '2026-01-02', '2026-01-03');
    await insertOccupyingReservation(roomId, '2026-01-02', '2026-01-03');

    const app = buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/rate-overrides/range',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, from: '2026-01-01', to: '2026-01-03', price_cents: 30000, units_available: 1 },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.price_min_stay_closed_applied).toBe(true);
    expect(body.units_available.failures).toEqual([{ date: '2026-01-02', occupied: 2 }]);

    const rows = await testDb
      .selectFrom('rate_overrides')
      .select([sql<string>`date::text`.as('date'), 'price_cents', 'units_available'])
      .orderBy('date')
      .execute();
    expect(rows).toEqual([
      { date: '2026-01-01', price_cents: 30000, units_available: 1 },
      { date: '2026-01-02', price_cents: 30000, units_available: null }, // price applied, cupo rejected
      { date: '2026-01-03', price_cents: 30000, units_available: 1 }, // 'to' is inclusive
    ]);
  });

  it('rejects to < from', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/rate-overrides/range',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, from: '2026-01-05', to: '2026-01-01', price_cents: 30000 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('404s for a non-existent room', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/rate-overrides/range',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: 999999, from: '2026-01-01', to: '2026-01-05', price_cents: 30000 },
    });

    expect(response.statusCode).toBe(404);
  });

  // Risk-review finding (8C, pre-merge): applyRateOverridesRange holds the
  // room's FOR UPDATE lock for the whole per-night write loop — an
  // unbounded range would hold that lock (and block createReservation for
  // this room) for as long as the batch takes. 400 nights is the accepted cap.
  it('rejects a range beyond the 400-night cap', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo');
    const app = buildApp();
    const from = '2026-01-01';
    const to = formatDateUTC(addDaysUTC(parseDateUTC(from), 400)); // 401 nights inclusive

    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/rate-overrides/range',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: roomId, from, to, price_cents: 30000 },
    });

    expect(response.statusCode).toBe(400);
  });

  // Deliberately does NOT exercise a real 400-night write: that's ~400
  // sequential round-trips inside one transaction and reliably blows past
  // vitest's default testTimeout — which (per server/CLAUDE.md's testTimeout
  // lesson) leaves the transaction, and the room's FOR UPDATE lock, running
  // server-side after vitest gives up on it client-side, wedging the NEXT
  // test's TRUNCATE. Using a non-existent room proves the schema boundary
  // (the request reaches applyRateOverridesRange and hits RoomNotFoundError,
  // not the "range too long" 400) without paying for or risking the writes.
  it('accepts a range exactly at the 400-night cap (schema does not reject it)', async () => {
    const token = await insertSessionCookie();
    const app = buildApp();
    const from = '2026-01-01';
    const to = formatDateUTC(addDaysUTC(parseDateUTC(from), 399)); // 400 nights inclusive

    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/rate-overrides/range',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { room_id: 999999, from, to, price_cents: 30000 },
    });

    expect(response.statusCode).toBe(404); // past schema validation, rejected only for room-not-found
  });
});

describe('PATCH /panel/rate-overrides/range — concurrency guard (SPEC § 6.4, § 7)', () => {
  // Identifies the rate-overrides guard's OWN `.selectFrom('rooms')...forUpdate()`
  // query (rateOverrides.ts) — same shape as createReservation's own lock
  // query (selects exactly `id`, no joins), which is the point: both must
  // serialize on the SAME row.
  function isRoomsForUpdateQuery(node: RootOperationNode): boolean {
    if (!selectReferencesTable(node, 'rooms')) return false;
    const selections = (node as { selections?: { selection?: { column?: { column?: { name?: string } } } }[] })
      .selections;
    return (selections?.length ?? 0) === 1 && selections![0]!.selection?.column?.column?.name === 'id';
  }

  // THE dangerous direction (per project owner): a reservation being created
  // concurrently with the cupo edit — NOT two edits racing each other. If the
  // guard's occupied-count read isn't serialized against createReservation's
  // own room-row lock, it can read a STALE (too-low) occupied count and
  // apply a units_available that's already below what just got booked —
  // exactly the inconsistent state § 6.4 exists to prevent.
  //
  // Simulates a createReservation already in flight (raw connection holding
  // the exact room-row FOR UPDATE lock, about to insert) while the REAL
  // applyRateOverridesRange service function runs concurrently, attempting
  // to set units_available=1 for a night that currently has 0 occupied (so
  // if the guard read now, it would wrongly succeed). The holder then
  // completes its insert (occupied becomes 1) and commits; only then does
  // the guard proceed — and it must reject that night (1 occupied > the
  // outgoing units_available=1 is fine, so we request units_available=0 to
  // force the conflict) because it re-reads occupancy AFTER the lock, not
  // before.
  //
  // DETERMINISTIC — same technique as panelManualReservation.test.ts's
  // createReservation-vs-createReservation lock test: `waitForLockWait`
  // polls Postgres's own `pg_stat_activity` for a genuine lock wait on the
  // `rooms` query, rather than inferring "blocked" from an outer promise's
  // timing (see queryBarrier.ts's doc comment for why a boolean timing check
  // is unsound here).
  it(
    'DETERMINISTIC: the cupo guard blocks on the SAME room-row FOR UPDATE lock createReservation holds, and never applies a stale units_available for a night that was reserved in the meantime',
    async () => {
      const roomId = await insertRoom('Triplo');
      const unitId = await insertUnit(roomId, 'T1');

      // Warm the pool first — a cold connection's first query can cost 300-400ms on its own.
      await Promise.all([
        testDb.selectFrom('reservations').select('id').limit(1).execute(),
        testDb.selectFrom('reservations').select('id').limit(1).execute(),
      ]);

      const holder = await testPool.connect();
      const { plugin: timingPlugin, timings } = createQueryTimingPlugin({ match: isRoomsForUpdateQuery });
      const measuredDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: testPool }), plugins: [timingPlugin] });

      let rangePromise!: ReturnType<typeof applyRateOverridesRange>;
      let sawGenuineLockWait = false;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);

        rangePromise = applyRateOverridesRange(measuredDb, {
          roomId,
          from: '2026-01-10',
          to: '2026-01-10',
          units_available: 0,
        });
        rangePromise.catch(() => {});

        sawGenuineLockWait = await waitForLockWait(testPool, {
          excludePids: [holder.processID!],
          queryContains: 'rooms',
        });

        // Finish what createReservation does, still holding the lock: book
        // the night, making it occupied=1 right as the guard is parked
        // waiting for this same lock.
        const inserted = await holder.query<{ id: number }>(
          `INSERT INTO reservations (room_id, room_unit_id, check_in, check_out, guests, status, total_cents)
           VALUES ($1, $2, '2026-01-10'::date, '2026-01-11'::date, 2, 'confirmed', 20000) RETURNING id`,
          [roomId, unitId],
        );
        await holder.query(
          `INSERT INTO reservation_nights (reservation_id, night, room_unit_id) VALUES ($1, '2026-01-10'::date, $2)`,
          [inserted.rows[0]!.id, unitId],
        );
        await holder.query('COMMIT');
      } catch (err) {
        await holder.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        holder.release();
      }

      expect(sawGenuineLockWait).toBe(true);

      const result = await rangePromise;
      // The guard woke up AFTER the reservation committed and correctly
      // rejected the night — proving its occupied-count read was NOT stale.
      expect(result.unitsAvailable).toEqual({ appliedCount: 0, failures: [{ date: '2026-01-10', occupied: 1 }] });

      // Confirms the wait was on the SPECIFIC FOR UPDATE query, not some other point in the call.
      expect(timings).toHaveLength(1);

      const overrideRows = await testDb.selectFrom('rate_overrides').selectAll().execute();
      expect(overrideRows).toHaveLength(0); // rejected — the stale-write never happened

      const reservationRows = await testDb.selectFrom('reservations').selectAll().execute();
      expect(reservationRows).toHaveLength(1); // the holder's booking committed successfully
    },
    15000,
  );
});

describe('authorization (config.calendar)', () => {
  it('403s a session without config.calendar', async () => {
    const roleId = await createRoleWithPermissions(testDb, []);
    const token = await createSessionCookieForRole(testDb, roleId);
    const roomId = await insertRoom('Triplo');
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: `/panel/rate-overrides?room_id=${roomId}&from=2026-01-01&to=2026-01-31`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(403);
  });

  it('200s a session with config.calendar', async () => {
    const roleId = await createRoleWithPermissions(testDb, ['config.calendar']);
    const token = await createSessionCookieForRole(testDb, roleId);
    const roomId = await insertRoom('Triplo');
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: `/panel/rate-overrides?room_id=${roomId}&from=2026-01-01&to=2026-01-31`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
  });
});
