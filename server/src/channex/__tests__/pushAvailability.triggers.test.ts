/**
 * SPEC-modulo-12C § 7: "la función de push nunca debe poder hacer fallar la
 * operación local que la dispara — testear esto explícitamente (simular que
 * Channex responde error y confirmar que la reserva/cancelación/movimiento
 * local se completa igual)." Mocks channexClient.js to always reject, wires
 * a real Channex config + mapping so the push is actually attempted (not
 * skipped as unconfigured), then verifies createReservation/cancelReservation
 * still succeed — and that a push was genuinely attempted (via vi.waitFor),
 * so this test can't pass by accident because the push never fired.
 */
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { setRoomTypeMap } from '../channexRoomTypeMap.js';
import { updateChannexConfig } from '../channexConfig.js';
import { createReservation } from '../../availability/createReservation.js';
import { cancelReservation } from '../../panel/reservationActions.js';
import { generateReservationCode } from '../../reservations/generateCode.js';
import { hashPassword } from '../../auth/hashPassword.js';

const pushAvailabilityMock = vi.fn().mockRejectedValue(new Error('Channex is down'));
const pushRestrictionsMock = vi.fn().mockRejectedValue(new Error('Channex is down'));

vi.mock('../channexClient.js', () => ({
  pushAvailability: (...args: unknown[]) => pushAvailabilityMock(...args),
  pushRestrictions: (...args: unknown[]) => pushRestrictionsMock(...args),
}));

const ROOM_TYPE_ID = '7f1fe757-cf66-4878-82fe-ae25920e8d1f';

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE reservation_nights, reservations, rate_overrides, room_rates, channex_room_type_map, channex_config, rooms, users RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

async function insertUser(): Promise<number> {
  const user = await testDb
    .insertInto('users')
    .values({ email: 'operator@catavento.test', name: 'Operator', password_hash: await hashPassword('whatever') })
    .returning('id')
    .executeTakeFirstOrThrow();
  return user.id;
}

async function insertRoom(): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({ name: 'Casal', capacity: 2, adults_only: false, pets_allowed: false, default_min_stay: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();

  await testDb.insertInto('room_rates').values({ room_id: room.id, occupancy: 2, weekday_cents: 20000, weekend_cents: 25000 }).execute();
  await testDb.insertInto('room_units').values({ room_id: room.id, label: '101' }).execute();

  return room.id;
}

async function connectAndMapRoom(roomId: number): Promise<void> {
  await updateChannexConfig(testDb, { propertyId: 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f', isActive: true });
  await setRoomTypeMap(testDb, { roomId, channexRoomTypeId: ROOM_TYPE_ID, channexRatePlanId: null });
}

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  vi.clearAllMocks();
  await resetDb();
});

describe('push failures never block the local operation that triggers them', () => {
  it('createReservation still succeeds when the Channex push rejects', async () => {
    const roomId = await insertRoom();
    await connectAndMapRoom(roomId);

    const result = await createReservation(testDb, {
      roomId,
      checkIn: '2026-07-16',
      checkOut: '2026-07-17',
      guests: 2,
      origin: 'web',
      code: generateReservationCode(),
    });

    expect(result.id).toEqual(expect.any(Number));

    // Proves the push was genuinely attempted (and failed), not silently skipped.
    await vi.waitFor(() => expect(pushAvailabilityMock).toHaveBeenCalledTimes(1));
  });

  it('cancelReservation still succeeds when the Channex push rejects', async () => {
    const roomId = await insertRoom();
    await connectAndMapRoom(roomId);
    const userId = await insertUser();

    const code = generateReservationCode();
    await createReservation(testDb, {
      roomId,
      checkIn: '2026-07-16',
      checkOut: '2026-07-17',
      guests: 2,
      origin: 'web',
      code,
    });
    await vi.waitFor(() => expect(pushAvailabilityMock).toHaveBeenCalledTimes(1));
    pushAvailabilityMock.mockClear();

    await cancelReservation(testDb, { code, changedBy: userId });

    const reservation = await testDb.selectFrom('reservations').select('status').where('code', '=', code).executeTakeFirstOrThrow();
    expect(reservation.status).toBe('cancelled');

    await vi.waitFor(() => expect(pushAvailabilityMock).toHaveBeenCalledTimes(1));
  });
});
