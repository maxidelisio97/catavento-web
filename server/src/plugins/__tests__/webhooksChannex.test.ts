/**
 * Integration tests for SPEC-modulo-12B-reservas-entrantes.md § 3.2/§ 3.3 —
 * POST /webhooks/channex. Focus: secret verification (never mixed up with
 * Asaas's), and that a valid delivery reaches processBookingRevision and
 * acks. Mirrors panelChannex.test.ts's app-building/mocking conventions.
 */
import Fastify from 'fastify';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CHANNEX_WEBHOOK_SECRET = 'channex-test-secret';

const { ackBookingRevision } = vi.hoisted(() => ({ ackBookingRevision: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../channex/channexClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../channex/channexClient.js')>();
  return { ...actual, ackBookingRevision };
});

const { testDb } = await import('../../db/testClient.js');
const { registerErrorHandler } = await import('../../errorHandler.js');
const { setRoomTypeMap } = await import('../../channex/channexRoomTypeMap.js');
const webhooksChannexPlugin = (await import('../webhooksChannex.js')).default;

function buildApp() {
  const app = Fastify();
  app.register(webhooksChannexPlugin, { db: testDb });
  registerErrorHandler(app);
  return app;
}

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE reservation_nights, reservations, rate_overrides, room_rates, rooms RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

beforeEach(async () => {
  await resetDb();
  ackBookingRevision.mockClear();
});

function channexBody(overrides: Record<string, unknown> = {}) {
  return {
    booking: {
      id: 'BK-WEBHOOK-1',
      revision_id: 'REV-WEBHOOK-1',
      status: 'new',
      checkin_date: '2026-10-01',
      checkout_date: '2026-10-04',
      occupancy: { adults: 2 },
      rooms: [{ room_type_id: overrides.channexRoomTypeId }],
      customer: { name: 'Guest', mail: 'guest@example.com' },
      amount: 300,
      ...overrides,
    },
  };
}

describe('POST /webhooks/channex — verificación de secreto', () => {
  it('rechaza sin el header correcto', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'POST', url: '/webhooks/channex', payload: channexBody() });
    expect(response.statusCode).toBe(401);
    expect(ackBookingRevision).not.toHaveBeenCalled();
  });

  it('rechaza con un secreto incorrecto', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/channex',
      headers: { 'x-channex-webhook-secret': 'wrong-secret' },
      payload: channexBody(),
    });
    expect(response.statusCode).toBe(401);
    expect(ackBookingRevision).not.toHaveBeenCalled();
  });

  it('procesa y ackea con el secreto correcto', async () => {
    const room = await testDb
      .insertInto('rooms')
      .values({ name: 'Casal', capacity: 2, pets_allowed: false, default_min_stay: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await testDb.insertInto('room_rates').values({ room_id: room.id, occupancy: 2, weekday_cents: 10000, weekend_cents: 15000 }).execute();
    await testDb.insertInto('room_units').values({ room_id: room.id, label: '101' }).execute();

    const channexRoomTypeId = randomUUID();
    await setRoomTypeMap(testDb, { roomId: room.id, channexRoomTypeId, channexRatePlanId: null });

    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/channex',
      headers: { 'x-channex-webhook-secret': 'channex-test-secret' },
      payload: channexBody({ channexRoomTypeId }),
    });

    expect(response.statusCode).toBe(200);
    expect(ackBookingRevision).toHaveBeenCalledWith('REV-WEBHOOK-1');

    const reservation = await testDb
      .selectFrom('reservations')
      .selectAll()
      .where('channex_booking_id', '=', 'BK-WEBHOOK-1')
      .executeTakeFirstOrThrow();
    expect(reservation.status).toBe('confirmed');
    expect(reservation.origin).toBe('ota');
  });
});
