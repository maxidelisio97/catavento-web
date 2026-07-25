/**
 * Integration tests for SPEC-modulo-7-gestion-operativa.md § 7 —
 * POST /panel/reservations/manual.
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
import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, testPool } from '../../db/testClient.js';
import type { DB } from '../../db/types.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelManualReservationPlugin from '../panelManualReservation.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';

// Forces two truly concurrent requests to interleave instead of "accidentally"
// serializing on fast localhost Postgres — same plugin used by the other M7
// concurrency tests (panelMoveReservation.test.ts, panelReservationActions.test.ts).
class ArtificialRaceWindowPlugin implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs) {
    return args.node;
  }
  async transformResult(args: PluginTransformResultArgs) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return args.result;
  }
}

function buildApp(db: Kysely<DB> = testDb) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelManualReservationPlugin, { db });
  registerErrorHandler(app);
  return app;
}

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE payments, reservation_nights, reservations, room_units, rooms, settings, sessions, users RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
  await testDb
    .insertInto('settings')
    .values([
      { key: 'deposit_percent', value: '50' },
      { key: 'hold_minutes', value: '30' },
      { key: 'pet_fee_cents', value: '3000' },
    ])
    .execute();
}

interface RoomOptions {
  capacity?: number;
  adultsOnly?: boolean;
  petsAllowed?: boolean;
  defaultMinStay?: number;
}

async function insertRoom(name: string, options: RoomOptions = {}): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({
      name,
      capacity: options.capacity ?? 2,
      adults_only: options.adultsOnly ?? false,
      pets_allowed: options.petsAllowed ?? false,
      default_min_stay: options.defaultMinStay ?? 1,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await testDb
    .insertInto('room_rates')
    .values({ room_id: room.id, occupancy: options.capacity ?? 2, weekday_cents: 10000, weekend_cents: 15000 })
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

// Monday + Tuesday — both weekday nights, so total_cents math in the tests
// below stays simple (2 * weekday_cents) without weekend-rate surprises.
const basePayload = {
  room_id: 0,
  check_in: '2026-10-05',
  check_out: '2026-10-07',
  adults: 2,
  guest_name: 'Ana Souza',
  payment_status: 'none' as const,
};

beforeEach(async () => {
  await resetDb();
});

describe('POST /panel/reservations/manual', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/manual',
      payload: { ...basePayload, room_id: 1 },
    });
    expect(response.statusCode).toBe(401);
  });

  it('creates confirmed with origin=manual, no expiry, payment_status=none leaves balance_due == total', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo', { capacity: 3 });
    await insertUnit(roomId, 'T1');
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/manual',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { ...basePayload, room_id: roomId },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe('confirmed');
    expect(body.origin).toBe('manual');
    expect(body.money.total_cents).toBe(20000); // 2 nights * 10000 weekday
    expect(body.money.paid_cents).toBe(0);
    expect(body.money.balance_cents).toBe(20000);

    const row = await testDb
      .selectFrom('reservations')
      .select(['status', 'origin', 'expires_at', 'created_by'])
      .where('code', '=', body.code)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('confirmed');
    expect(row.origin).toBe('manual');
    expect(row.expires_at).toBeNull(); // § 7.1: manual never holds/expires
    expect(row.created_by).not.toBeNull();
  });

  it('payment_status=deposit_paid registers a deposit payment for deposit_percent of the total', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo', { capacity: 3 });
    await insertUnit(roomId, 'T1');
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/manual',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { ...basePayload, room_id: roomId, payment_status: 'deposit_paid', payment_method: 'cash' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.money.total_cents).toBe(20000);
    expect(body.money.paid_cents).toBe(10000); // 50% deposit
    expect(body.money.balance_cents).toBe(10000);

    const payment = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', body.id)
      .executeTakeFirstOrThrow();
    expect(payment.kind).toBe('deposit');
    expect(payment.method).toBe('cash');
    expect(payment.amount_cents).toBe(10000);
    expect(payment.status).toBe('received');
  });

  it('payment_status=paid_full registers a SINGLE balance payment covering the whole total (balance_due == 0)', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo', { capacity: 3 });
    await insertUnit(roomId, 'T1');
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/manual',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { ...basePayload, room_id: roomId, payment_status: 'paid_full', payment_method: 'pix_manual' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.money.paid_cents).toBe(20000);
    expect(body.money.balance_cents).toBe(0);

    const payments = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', body.id)
      .execute();
    expect(payments).toHaveLength(1);
    expect(payments[0]!.kind).toBe('balance');
    expect(payments[0]!.amount_cents).toBe(20000);
  });

  it('400 PAYMENT_METHOD_REQUIRED when payment_status needs a method and none is given', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo', { capacity: 3 });
    await insertUnit(roomId, 'T1');
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/manual',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { ...basePayload, room_id: roomId, payment_status: 'paid_full' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('PAYMENT_METHOD_REQUIRED');
  });

  it('override_total_cents replaces the calculated total as the frozen price', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo', { capacity: 3 });
    await insertUnit(roomId, 'T1');
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/manual',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { ...basePayload, room_id: roomId, override_total_cents: 15000 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().money.total_cents).toBe(15000);

    const row = await testDb
      .selectFrom('reservations')
      .select('override_total_cents')
      .where('code', '=', response.json().code)
      .executeTakeFirstOrThrow();
    expect(row.override_total_cents).toBe(15000);
  });

  it('409 NO_AVAILABILITY when no unit of the requested type is free — no escape hatch, even with force_commercial', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal', { capacity: 2 });
    const unitId = await insertUnit(roomId, 'C1');
    // Occupy the only unit for the requested range.
    const other = await testDb
      .insertInto('reservations')
      .values({
        room_id: roomId,
        room_unit_id: unitId,
        check_in: '2026-10-05',
        check_out: '2026-10-07',
        guests: 2,
        status: 'confirmed',
        total_cents: 20000,
        code: 'CAT-BLOCKED',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await testDb
      .insertInto('reservation_nights')
      .values([
        { reservation_id: other.id, night: '2026-10-05', room_unit_id: unitId },
        { reservation_id: other.id, night: '2026-10-06', room_unit_id: unitId },
      ])
      .execute();
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/manual',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { ...basePayload, room_id: roomId, adults: 2, force_commercial: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('NO_AVAILABILITY');
  });

  it('409 ADULTS_ONLY_ROOM when the room is adults-only and children/babies are given — hard rule, no force_commercial escape hatch', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal', { capacity: 2, adultsOnly: true });
    await insertUnit(roomId, 'C1');
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/manual',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { ...basePayload, room_id: roomId, children: 1, children_ages: [7], force_commercial: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('ADULTS_ONLY_ROOM');

    const rows = await testDb.selectFrom('reservations').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('409 PETS_NOT_ALLOWED when the room does not allow pets — hard rule, no force_commercial escape hatch', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal', { capacity: 2, petsAllowed: false });
    await insertUnit(roomId, 'C1');
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/manual',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { ...basePayload, room_id: roomId, pets: true, force_commercial: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('PETS_NOT_ALLOWED');

    const rows = await testDb.selectFrom('reservations').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('pets=true on a pets-allowed room freezes nights * pet_fee_cents into pet_fee_cents and adds it to total_cents', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo', { capacity: 3, petsAllowed: true });
    await insertUnit(roomId, 'T1');
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/manual',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { ...basePayload, room_id: roomId, pets: true },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.pets).toBe(true);
    // 2 nights * 10000 (room) + 2 nights * 3000 (pet_fee_cents) = 26000
    expect(body.money.total_cents).toBe(26000);
    expect(body.money.pet_fee_cents).toBe(6000);

    const row = await testDb
      .selectFrom('reservations')
      .select(['pets', 'pet_fee_cents', 'total_cents'])
      .where('code', '=', body.code)
      .executeTakeFirstOrThrow();
    expect(row.pets).toBe(true);
    expect(row.pet_fee_cents).toBe(6000);
    expect(row.total_cents).toBe(26000);
  });

  it('pets=true + payment_status=deposit_paid computes the deposit off the total INCLUDING the pet fee', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo', { capacity: 3, petsAllowed: true });
    await insertUnit(roomId, 'T1');
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/reservations/manual',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: {
        ...basePayload,
        room_id: roomId,
        pets: true,
        payment_status: 'deposit_paid',
        payment_method: 'cash',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    // total = 26000 (20000 room + 6000 pet fee); deposit must be 50% of THAT,
    // not of the 20000 room-only price — regression for the review finding
    // where calculateDeposit was fed price.totalCents instead of the frozen total.
    expect(body.money.total_cents).toBe(26000);
    expect(body.money.paid_cents).toBe(13000);
    expect(body.money.balance_cents).toBe(13000);

    const payment = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', body.id)
      .executeTakeFirstOrThrow();
    expect(payment.amount_cents).toBe(13000);
  });

  it('422 COMMERCIAL_WARNING when capacity is exceeded, nothing written; 201 after retry with force_commercial', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Casal', { capacity: 2 });
    await insertUnit(roomId, 'C1');
    const app = buildApp();

    const warned = await app.inject({
      method: 'POST',
      url: '/panel/reservations/manual',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { ...basePayload, room_id: roomId, adults: 3 },
    });
    expect(warned.statusCode).toBe(422);
    expect(warned.json().error).toBe('COMMERCIAL_WARNING');
    expect(warned.json().warnings).toEqual([
      { code: 'CAPACITY_EXCEEDED', message: 'guests exceeds room capacity (2)' },
    ]);
    expect(await testDb.selectFrom('reservations').selectAll().execute()).toHaveLength(0);

    const forced = await app.inject({
      method: 'POST',
      url: '/panel/reservations/manual',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { ...basePayload, room_id: roomId, adults: 3, force_commercial: true },
    });
    expect(forced.statusCode).toBe(201);
  });

  it('422 COMMERCIAL_WARNING when the stay is below default_min_stay, nothing written; 201 after retry with force_commercial', async () => {
    const token = await insertSessionCookie();
    const roomId = await insertRoom('Triplo', { capacity: 3, defaultMinStay: 3 });
    await insertUnit(roomId, 'T1');
    const app = buildApp();

    // basePayload is a 2-night stay, below the 3-night minimum.
    const warned = await app.inject({
      method: 'POST',
      url: '/panel/reservations/manual',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { ...basePayload, room_id: roomId },
    });
    expect(warned.statusCode).toBe(422);
    expect(warned.json().error).toBe('COMMERCIAL_WARNING');
    expect(warned.json().warnings).toEqual([
      { code: 'MIN_STAY_NOT_MET', message: 'Stay of 2 nights is below the 3-night minimum' },
    ]);
    expect(await testDb.selectFrom('reservations').selectAll().execute()).toHaveLength(0);

    const forced = await app.inject({
      method: 'POST',
      url: '/panel/reservations/manual',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { ...basePayload, room_id: roomId, force_commercial: true },
    });
    expect(forced.statusCode).toBe(201);
  });

  describe('concurrency: two manual reservations racing for the last unit', () => {
    it('smoke: one succeeds (201), the other is rejected (409), never both 201', async () => {
      const token = await insertSessionCookie();
      const roomId = await insertRoom('Casal', { capacity: 2 });
      await insertUnit(roomId, 'C1');
      const app = buildApp();

      const [first, second] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/panel/reservations/manual',
          cookies: { [SESSION_COOKIE_NAME]: token },
          payload: { ...basePayload, room_id: roomId },
        }),
        app.inject({
          method: 'POST',
          url: '/panel/reservations/manual',
          cookies: { [SESSION_COOKIE_NAME]: token },
          payload: { ...basePayload, room_id: roomId },
        }),
      ]);

      const statusCodes = [first.statusCode, second.statusCode].sort();
      expect(statusCodes).toEqual([201, 409]);

      const rows = await testDb.selectFrom('reservation_nights').selectAll().execute();
      // Exactly one reservation's nights survive on the single unit — never
      // two rows fighting for the same (room_unit_id, night).
      expect(rows).toHaveLength(2);
    });

    // DETERMINISTIC version, same rationale as the other M7 concurrency
    // tests: a bare Promise.all over HTTP tends to fully serialize "by luck"
    // on fast localhost Postgres. This widens the window between the
    // availability read and the reservation_nights insert so both requests
    // are guaranteed to interleave, proving the room-row FOR UPDATE lock
    // (not luck) is what prevents a double-booking here.
    it('DETERMINISTIC: with the race window artificially widened, still never two 201s for the same unit', async () => {
      const token = await insertSessionCookie();
      const roomId = await insertRoom('Casal', { capacity: 2 });
      await insertUnit(roomId, 'C1');
      const delayedDb = new Kysely<DB>({
        dialect: new PostgresDialect({ pool: testPool }),
        plugins: [new ArtificialRaceWindowPlugin()],
      });
      const app = buildApp(delayedDb);

      const [first, second] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/panel/reservations/manual',
          cookies: { [SESSION_COOKIE_NAME]: token },
          payload: { ...basePayload, room_id: roomId },
        }),
        app.inject({
          method: 'POST',
          url: '/panel/reservations/manual',
          cookies: { [SESSION_COOKIE_NAME]: token },
          payload: { ...basePayload, room_id: roomId },
        }),
      ]);

      const statusCodes = [first.statusCode, second.statusCode].sort();
      expect(statusCodes).toEqual([201, 409]);

      // createReservation inserts `reservations` and `reservation_nights` in
      // the SAME transaction — the loser's reservation_nights insert hits
      // the unique constraint and rolls back its reservations row too, so
      // only the winner's reservation persists.
      const rows = await testDb.selectFrom('reservations').selectAll().execute();
      expect(rows).toHaveLength(1);
    });
  });
});
