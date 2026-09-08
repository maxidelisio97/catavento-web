/**
 * Integration tests for SPEC-modulo-12B-reservas-entrantes.md § 3.1 (core
 * revision processor) and § 3.5 (conflict retry). Mirrors the fixture
 * conventions of reservationNights.test.ts (local rooms/units per test).
 *
 * Deliberately drives `processBookingRevision` directly with an already-
 * normalized `ChannexBookingRevisionInput` — payload parsing
 * (channexPayload.ts) is untested here on purpose (see that file's own
 * docstring: its field mapping isn't verified against a real Channex
 * payload yet, so pinning tests to a guessed raw shape would be testing the
 * guess, not the logic).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { createReservation, NoAvailabilityError } from '../../availability/createReservation.js';
import { setRoomTypeMap } from '../channexRoomTypeMap.js';
import { processBookingRevision, type ChannexBookingRevisionInput } from '../processBookingRevision.js';
import { retryOtaConflict } from '../../panel/otaConflicts.js';

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE reservation_nights, reservations, rate_overrides, room_rates, rooms RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

interface RoomFixture {
  roomId: number;
  channexRoomTypeId: string;
}

async function insertMappedRoom(totalUnits = 1): Promise<RoomFixture> {
  const room = await testDb
    .insertInto('rooms')
    .values({ name: 'Casal', capacity: 2, pets_allowed: false, default_min_stay: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();

  await testDb
    .insertInto('room_rates')
    .values({ room_id: room.id, occupancy: 2, weekday_cents: 10000, weekend_cents: 15000 })
    .execute();

  if (totalUnits > 0) {
    await testDb
      .insertInto('room_units')
      .values(Array.from({ length: totalUnits }, (_, i) => ({ room_id: room.id, label: `${room.id}-${i + 1}` })))
      .execute();
  }

  const channexRoomTypeId = randomUUID();
  await setRoomTypeMap(testDb, { roomId: room.id, channexRoomTypeId, channexRatePlanId: null });

  return { roomId: room.id, channexRoomTypeId };
}

function revision(overrides: Partial<ChannexBookingRevisionInput> = {}): ChannexBookingRevisionInput {
  return {
    bookingId: 'BK-1',
    revisionId: 'REV-1',
    status: 'new',
    checkIn: '2026-09-10',
    checkOut: '2026-09-13',
    guests: 2,
    guestName: 'Airbnb Guest',
    amountCents: 30000,
    ...overrides,
  };
}

beforeEach(async () => {
  await resetDb();
});

describe('processBookingRevision — camino feliz', () => {
  it('new: crea reserva con unidad asignada automáticamente, origin=ota, sin depósito', async () => {
    const { roomId, channexRoomTypeId } = await insertMappedRoom();

    const outcome = await processBookingRevision(testDb, revision({ channexRoomTypeId }));

    expect(outcome.kind).toBe('created');
    const reservationId = (outcome as { reservationId: number }).reservationId;

    const row = await testDb.selectFrom('reservations').selectAll().where('id', '=', reservationId).executeTakeFirstOrThrow();
    expect(row.origin).toBe('ota');
    expect(row.status).toBe('confirmed');
    expect(row.room_id).toBe(roomId);
    expect(row.channex_booking_id).toBe('BK-1');
    expect(row.channex_last_revision_id).toBe('REV-1');
    expect(row.deposit_cents).toBeNull();
    expect(row.total_cents).toBe(30000);

    const nights = await testDb
      .selectFrom('reservation_nights')
      .select('room_unit_id')
      .where('reservation_id', '=', reservationId)
      .execute();
    expect(nights).toHaveLength(3);
    expect(new Set(nights.map((n) => n.room_unit_id)).size).toBe(1);
  });

  it('modified: actualiza fechas/huéspedes/monto de la reserva existente y reasigna reservation_nights', async () => {
    const { channexRoomTypeId } = await insertMappedRoom();
    await processBookingRevision(testDb, revision({ channexRoomTypeId }));

    const outcome = await processBookingRevision(
      testDb,
      revision({
        channexRoomTypeId,
        revisionId: 'REV-2',
        status: 'modified',
        checkIn: '2026-09-11',
        checkOut: '2026-09-15',
        guests: 3,
        amountCents: 50000,
      }),
    );

    expect(outcome.kind).toBe('modified');
    const reservationId = (outcome as { reservationId: number }).reservationId;

    const row = await testDb
      .selectFrom('reservations')
      .select([
        'guests',
        'total_cents',
        'channex_last_revision_id',
        'status',
        sql<string>`check_in::text`.as('check_in'),
        sql<string>`check_out::text`.as('check_out'),
      ])
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();
    expect(row.check_in).toBe('2026-09-11');
    expect(row.check_out).toBe('2026-09-15');
    expect(row.guests).toBe(3);
    expect(row.total_cents).toBe(50000);
    expect(row.channex_last_revision_id).toBe('REV-2');
    expect(row.status).toBe('confirmed');

    const nights = await testDb
      .selectFrom('reservation_nights')
      .select('night')
      .where('reservation_id', '=', reservationId)
      .execute();
    expect(nights).toHaveLength(4);
  });

  it('cancelled: cancela la reserva local y libera sus noches', async () => {
    const { channexRoomTypeId } = await insertMappedRoom();
    const created = await processBookingRevision(testDb, revision({ channexRoomTypeId }));
    const reservationId = (created as { reservationId: number }).reservationId;

    const outcome = await processBookingRevision(
      testDb,
      revision({ channexRoomTypeId, revisionId: 'REV-2', status: 'cancelled' }),
    );

    expect(outcome).toEqual({ kind: 'cancelled', reservationId });

    const row = await testDb.selectFrom('reservations').selectAll().where('id', '=', reservationId).executeTakeFirstOrThrow();
    expect(row.status).toBe('cancelled');

    const nights = await testDb.selectFrom('reservation_nights').select('id').where('reservation_id', '=', reservationId).execute();
    expect(nights).toHaveLength(0);
  });
});

describe('processBookingRevision — concurrencia (webhook + pull entregando la MISMA reserva nueva a la vez)', () => {
  // Risk-review finding (fresh-context, pre-merge): sin un lock por
  // channex_booking_id, dos entregas concurrentes de la primera revisión de
  // una reserva nueva (ej. el webhook y un pull manual solapados) podían
  // ambas ver "no existe todavía" y ambas intentar crear — produciendo un
  // ota_conflict fantasma para una reserva que la otra llamada ya había
  // creado con éxito. `pg_advisory_xact_lock(BOOKING_LOCK_NAMESPACE,
  // hashtext(bookingId))` en processBookingRevision serializa esto.
  // Promise.all real (no un holder con lock a mano): mismo patrón que
  // server/CLAUDE.md documenta como aceptable primer chequeo — si dos
  // llamadas verdaderamente concurrentes no alcanzan a solaparse, esto no
  // prueba nada por construcción, así que se verificó a mano sacando el
  // lock del código: sin él, esta corrida produce 2 filas en `reservations`
  // (una 'created' y una 'conflict' fantasma) en vez de 1.
  it('dos llamadas concurrentes a la misma reserva nueva no duplican ni crean un ota_conflict fantasma', async () => {
    const { channexRoomTypeId } = await insertMappedRoom(1);
    const input = revision({ channexRoomTypeId });

    const [first, second] = await Promise.all([processBookingRevision(testDb, input), processBookingRevision(testDb, input)]);

    const outcomes = [first.kind, second.kind].sort();
    // One of them created it; the other either found it already applied
    // (same revision -> noop_idempotent) or applied the exact same terminal
    // state again (modified onto itself, since the "existing" branch races
    // the same input) — never a phantom conflict.
    expect(outcomes).not.toContain('conflict');

    const reservations = await testDb.selectFrom('reservations').select('id').where('channex_booking_id', '=', 'BK-1').execute();
    expect(reservations).toHaveLength(1);

    const nights = await testDb
      .selectFrom('reservation_nights')
      .select('id')
      .where('reservation_id', '=', reservations[0]!.id)
      .execute();
    expect(nights).toHaveLength(3);
  });
});

describe('processBookingRevision — idempotencia', () => {
  it('procesar la misma revisión dos veces no duplica la reserva ni el conteo de unidades ocupadas', async () => {
    const { channexRoomTypeId } = await insertMappedRoom();
    const input = revision({ channexRoomTypeId });

    const first = await processBookingRevision(testDb, input);
    const second = await processBookingRevision(testDb, input);

    expect(first.kind).toBe('created');
    expect(second).toEqual({ kind: 'noop_idempotent' });

    const reservations = await testDb.selectFrom('reservations').select('id').where('channex_booking_id', '=', 'BK-1').execute();
    expect(reservations).toHaveLength(1);

    const nights = await testDb
      .selectFrom('reservation_nights')
      .select('id')
      .where('reservation_id', '=', reservations[0]!.id)
      .execute();
    expect(nights).toHaveLength(3);
  });
});

describe('processBookingRevision — conflicto (ota_conflict)', () => {
  it('sin unidad libre: la reserva entra como ota_conflict, sin reservation_nights, sin contar como ocupada', async () => {
    const { roomId, channexRoomTypeId } = await insertMappedRoom(1);

    // Occupies the only unit for the same dates via the normal web flow —
    // this is the "genuine overbooking" the OTA revision collides with.
    const existing = await createReservation(testDb, {
      roomId,
      checkIn: '2026-09-10',
      checkOut: '2026-09-13',
      guests: 2,
      status: 'confirmed',
    });

    const outcome = await processBookingRevision(testDb, revision({ channexRoomTypeId }));

    expect(outcome.kind).toBe('conflict');
    const conflictId = (outcome as { reservationId: number }).reservationId;

    const row = await testDb.selectFrom('reservations').selectAll().where('id', '=', conflictId).executeTakeFirstOrThrow();
    expect(row.status).toBe('ota_conflict');
    expect(row.origin).toBe('ota');
    expect(row.room_unit_id).toBeNull();

    const conflictNights = await testDb
      .selectFrom('reservation_nights')
      .select('id')
      .where('reservation_id', '=', conflictId)
      .execute();
    expect(conflictNights).toHaveLength(0);

    // Exactly ONE occupancy per night for the room's single unit — the
    // conflict never phantom-doubled the count.
    const allNights = await testDb.selectFrom('reservation_nights').select('night').execute();
    expect(allNights).toHaveLength(3);

    void existing;
  });

  it('resolución de conflicto: liberada la unidad, el retry la asigna y sale de ota_conflict', async () => {
    const { roomId, channexRoomTypeId } = await insertMappedRoom(1);

    const blocking = await createReservation(testDb, {
      roomId,
      checkIn: '2026-09-10',
      checkOut: '2026-09-13',
      guests: 2,
      status: 'confirmed',
    });

    const outcome = await processBookingRevision(testDb, revision({ channexRoomTypeId }));
    const conflictId = (outcome as { reservationId: number }).reservationId;

    // Free the unit up (mirrors cancelReservation's own release step,
    // without pulling in the panel's full cancel flow for this test).
    await testDb.deleteFrom('reservation_nights').where('reservation_id', '=', blocking.id).execute();
    await testDb.updateTable('reservations').set({ status: 'cancelled' }).where('id', '=', blocking.id).execute();

    const retryResult = await retryOtaConflict(testDb, conflictId);
    expect(retryResult).toEqual({ resolved: true });

    const row = await testDb.selectFrom('reservations').selectAll().where('id', '=', conflictId).executeTakeFirstOrThrow();
    expect(row.status).toBe('confirmed');

    const nights = await testDb.selectFrom('reservation_nights').select('id').where('reservation_id', '=', conflictId).execute();
    expect(nights).toHaveLength(3);
  });
});

describe('processBookingRevision — salto de closed/min-stay acotado a origin=ota', () => {
  it('una reserva de OTA se acepta aunque la fecha esté marcada closed localmente', async () => {
    const { roomId, channexRoomTypeId } = await insertMappedRoom();
    await testDb.insertInto('rate_overrides').values({ room_id: roomId, date: '2026-09-11', closed: true }).execute();

    const outcome = await processBookingRevision(testDb, revision({ channexRoomTypeId }));

    expect(outcome.kind).toBe('created');
  });

  it('una reserva web/manual sigue rechazando la fecha closed — el salto NO se cuela fuera de origin=ota', async () => {
    const { roomId } = await insertMappedRoom();
    await testDb.insertInto('rate_overrides').values({ room_id: roomId, date: '2026-09-11', closed: true }).execute();

    await expect(
      createReservation(testDb, {
        roomId,
        checkIn: '2026-09-10',
        checkOut: '2026-09-13',
        guests: 2,
      }),
    ).rejects.toBeInstanceOf(NoAvailabilityError);
  });
});
