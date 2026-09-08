/**
 * Integration tests for SPEC-modulo-12B-reservas-entrantes.md § 3.2/§ 3.3 —
 * POST /webhooks/channex. Focus: secret verification (never mixed up with
 * Asaas's), and that a valid delivery pulls the full revision by id and
 * reaches processBookingRevision + acks. Mirrors panelChannex.test.ts's
 * app-building/mocking conventions.
 *
 * The webhook body used here (`webhookEnvelope`) and the fetched revision
 * (`revisionResource`) both match the real shapes confirmed against
 * Channex's published docs (see webhooksChannex.ts/channexPayload.ts's own
 * docstrings, checked 2026-09-07) — NOT the older, incorrect assumption
 * that the webhook body carried full booking details directly.
 */
import Fastify from 'fastify';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CHANNEX_WEBHOOK_SECRET = 'channex-test-secret';

const { getBookingRevision, ackBookingRevision } = vi.hoisted(() => ({
  getBookingRevision: vi.fn(),
  ackBookingRevision: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../channex/channexClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../channex/channexClient.js')>();
  return { ...actual, getBookingRevision, ackBookingRevision };
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
  getBookingRevision.mockReset();
  ackBookingRevision.mockClear();
});

/** Confirmed real shape (Channex Webhook Collection docs): only identifiers, no booking details. */
function webhookEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    event: 'booking_new',
    payload: { booking_id: 'BK-WEBHOOK-1', property_id: 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f', revision_id: 'REV-WEBHOOK-1' },
    property_id: 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f',
    user_id: null,
    timestamp: '2026-09-07T00:00:00.000Z',
    ...overrides,
  };
}

/** Confirmed real shape (Channex Bookings Collection docs § Booking Revisions Feed), already flattened as channexClient.ts's getBookingRevision returns it. */
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
    expect(getBookingRevision).not.toHaveBeenCalled();
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
    expect(getBookingRevision).not.toHaveBeenCalled();
  });

  it('con el secreto correcto: trae la revisión completa por id, procesa y ackea', async () => {
    const room = await testDb
      .insertInto('rooms')
      .values({ name: 'Casal', capacity: 2, pets_allowed: false, default_min_stay: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await testDb.insertInto('room_rates').values({ room_id: room.id, occupancy: 2, weekday_cents: 10000, weekend_cents: 15000 }).execute();
    await testDb.insertInto('room_units').values({ room_id: room.id, label: '101' }).execute();

    const channexRoomTypeId = randomUUID();
    await setRoomTypeMap(testDb, { roomId: room.id, channexRoomTypeId, channexRatePlanId: null });
    getBookingRevision.mockResolvedValue(revisionResource(channexRoomTypeId));

    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/channex',
      headers: { 'x-channex-webhook-secret': 'channex-test-secret' },
      payload: webhookEnvelope(),
    });

    expect(response.statusCode).toBe(200);
    // The webhook body itself never carries the revision — this is the
    // pull-by-id call the real Channex docs require before any processing.
    expect(getBookingRevision).toHaveBeenCalledWith('REV-WEBHOOK-1');
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

  it('acepta el trigger genérico "booking" (dropdown single-select de la UI de Channex), no solo los tres específicos', async () => {
    const room = await testDb
      .insertInto('rooms')
      .values({ name: 'Casal', capacity: 2, pets_allowed: false, default_min_stay: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await testDb.insertInto('room_rates').values({ room_id: room.id, occupancy: 2, weekday_cents: 10000, weekend_cents: 15000 }).execute();
    await testDb.insertInto('room_units').values({ room_id: room.id, label: '101' }).execute();

    const channexRoomTypeId = randomUUID();
    await setRoomTypeMap(testDb, { roomId: room.id, channexRoomTypeId, channexRatePlanId: null });
    getBookingRevision.mockResolvedValue(revisionResource(channexRoomTypeId));

    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/channex',
      headers: { 'x-channex-webhook-secret': 'channex-test-secret' },
      payload: webhookEnvelope({ event: 'booking' }),
    });

    expect(response.statusCode).toBe(200);
    expect(getBookingRevision).toHaveBeenCalledWith('REV-WEBHOOK-1');
    expect(ackBookingRevision).toHaveBeenCalledWith('REV-WEBHOOK-1');
  });

  it('un envelope con un event desconocido no llama a getBookingRevision y responde 200', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/channex',
      headers: { 'x-channex-webhook-secret': 'channex-test-secret' },
      payload: { event: 'something_else', payload: {} },
    });

    expect(response.statusCode).toBe(200);
    expect(getBookingRevision).not.toHaveBeenCalled();
  });

  it('una falla al traer la revisión (API de Channex caída) responde 200 igual, sin ackear', async () => {
    getBookingRevision.mockRejectedValue(new Error('network error'));

    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/channex',
      headers: { 'x-channex-webhook-secret': 'channex-test-secret' },
      payload: webhookEnvelope(),
    });

    expect(response.statusCode).toBe(200);
    expect(ackBookingRevision).not.toHaveBeenCalled();
  });
});
