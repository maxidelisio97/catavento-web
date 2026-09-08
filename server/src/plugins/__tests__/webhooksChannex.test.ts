/**
 * Integration tests for SPEC-modulo-12B-reservas-entrantes.md § 3.2/§ 3.3 —
 * POST /webhooks/channex. Focus: secret verification (never mixed up with
 * Asaas's), and that a valid delivery triggers a full feed pull.
 *
 * The webhook body used here (`webhookEnvelope`) matches the REAL shape
 * confirmed by a live delivery from staging.channex.io on 2026-09-08 (see
 * webhooksChannex.ts's own docstring): `{event, property_id, user_id,
 * timestamp}` — no booking_id/revision_id anywhere, which is why this
 * handler triggers a full pull instead of fetching one revision by id.
 */
import Fastify from 'fastify';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CHANNEX_WEBHOOK_SECRET = 'channex-test-secret';

const { fetchBookingRevisionsFeed, ackBookingRevision } = vi.hoisted(() => ({
  fetchBookingRevisionsFeed: vi.fn().mockResolvedValue([]),
  ackBookingRevision: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../channex/channexClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../channex/channexClient.js')>();
  return { ...actual, fetchBookingRevisionsFeed, ackBookingRevision };
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

const PROPERTY_ID = 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f';

beforeEach(async () => {
  await resetDb();
  fetchBookingRevisionsFeed.mockReset().mockResolvedValue([]);
  ackBookingRevision.mockClear();
});

/** Confirmed real shape (live capture, 2026-09-08) — no payload/booking_id/revision_id. */
function webhookEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    event: 'booking',
    property_id: PROPERTY_ID,
    user_id: null,
    timestamp: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

/** Same flattened shape channexClient.ts's fetchBookingRevisionsFeed produces. */
function revisionResource(channexRoomTypeId: string) {
  return {
    id: 'REV-WEBHOOK-1',
    booking_id: 'BK-WEBHOOK-1',
    status: 'new',
    rooms: [{ room_type_id: channexRoomTypeId }],
    customer: { name: 'Guest', surname: 'OTA', mail: 'guest@example.com' },
    occupancy: { adults: 2, children: 0 },
    arrival_date: '2026-10-01',
    departure_date: '2026-10-04',
    amount: '300.00',
    currency: 'BRL',
  };
}

describe('POST /webhooks/channex — verificación de secreto', () => {
  it('rechaza sin el header correcto', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'POST', url: '/webhooks/channex', payload: webhookEnvelope() });
    expect(response.statusCode).toBe(401);
    expect(fetchBookingRevisionsFeed).not.toHaveBeenCalled();
  });

  it('rechaza con un secreto incorrecto', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/channex',
      headers: { 'x-channex-webhook-secret': 'wrong-secret' },
      payload: webhookEnvelope(),
    });
    expect(response.statusCode).toBe(401);
    expect(fetchBookingRevisionsFeed).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/channex — dispara un pull completo del feed', () => {
  it('con el secreto correcto: llama a fetchBookingRevisionsFeed con el property_id del envelope, procesa y ackea', async () => {
    const room = await testDb
      .insertInto('rooms')
      .values({ name: 'Casal', capacity: 2, pets_allowed: false, default_min_stay: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await testDb.insertInto('room_rates').values({ room_id: room.id, occupancy: 2, weekday_cents: 10000, weekend_cents: 15000 }).execute();
    await testDb.insertInto('room_units').values({ room_id: room.id, label: '101' }).execute();

    const channexRoomTypeId = randomUUID();
    await setRoomTypeMap(testDb, { roomId: room.id, channexRoomTypeId, channexRatePlanId: null });
    fetchBookingRevisionsFeed.mockResolvedValue([revisionResource(channexRoomTypeId)]);

    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/channex',
      headers: { 'x-channex-webhook-secret': 'channex-test-secret' },
      payload: webhookEnvelope(),
    });

    expect(response.statusCode).toBe(200);
    expect(fetchBookingRevisionsFeed).toHaveBeenCalledWith(PROPERTY_ID);
    expect(ackBookingRevision).toHaveBeenCalledWith('REV-WEBHOOK-1');

    const reservation = await testDb
      .selectFrom('reservations')
      .selectAll()
      .where('channex_booking_id', '=', 'BK-WEBHOOK-1')
      .executeTakeFirstOrThrow();
    expect(reservation.status).toBe('confirmed');
    expect(reservation.origin).toBe('ota');
    expect(reservation.guest_name).toBe('Guest OTA');
    expect(reservation.total_cents).toBe(30000);
  });

  it('un envelope con un event desconocido no dispara el pull y responde 200', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/channex',
      headers: { 'x-channex-webhook-secret': 'channex-test-secret' },
      payload: { event: 'something_else', property_id: PROPERTY_ID },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchBookingRevisionsFeed).not.toHaveBeenCalled();
  });

  it('acepta el trigger genérico "booking" (confirmado en vivo), no solo los tres específicos de la API docs', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/channex',
      headers: { 'x-channex-webhook-secret': 'channex-test-secret' },
      payload: webhookEnvelope({ event: 'booking' }),
    });

    expect(response.statusCode).toBe(200);
    expect(fetchBookingRevisionsFeed).toHaveBeenCalledWith(PROPERTY_ID);
  });

  it('una falla en el pull (API de Channex caída) responde 200 igual', async () => {
    fetchBookingRevisionsFeed.mockRejectedValue(new Error('network error'));

    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/channex',
      headers: { 'x-channex-webhook-secret': 'channex-test-secret' },
      payload: webhookEnvelope(),
    });

    expect(response.statusCode).toBe(200);
  });
});
