/**
 * Explicit re-run-safety test for the data-migration SQL used by
 * migrations/1784671660831_add-reservation-nights-and-origin.ts (see
 * expandReservationNightsSql.ts), per SPEC-modulo-6-panel-base.md § "6A.1:
 * la migración debe poder correrse dos veces sin efecto adicional".
 *
 * Executes the EXACT same SQL the migration runs (imported from the shared
 * module, not hand-copied) twice against fixture data, proving:
 * - the second run doesn't fail,
 * - it doesn't duplicate rows,
 * - the post-migration count-assert still correctly passes on the second
 *   run even though its own INSERT affects 0 rows that time (the assert
 *   re-counts reservation_nights fresh per reservation, it never trusts the
 *   INSERT's affected-row count — see the shared SQL module's docstring).
 */
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { EXPAND_RESERVATION_NIGHTS_SQL } from '../expandReservationNightsSql.js';

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE reservation_nights, reservations, rate_overrides, room_rates, rooms RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

async function insertRoom(name: string, capacity: number): Promise<number> {
  const room = await testDb
    .insertInto('rooms')
    .values({ name, capacity, pets_allowed: false, default_min_stay: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();
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

beforeEach(async () => {
  await resetDb();
});

describe('reservation_nights data migration — re-run safety', () => {
  it('running the migration SQL twice does not fail, does not duplicate rows, and both runs report the correct state', async () => {
    const casalId = await insertRoom('Casal', 2);
    const unitA = await insertUnit(casalId, '101');

    // A pre-6A style reservation: room_unit_id set on `reservations`, no
    // reservation_nights rows yet — exactly the "before" state the
    // migration expands from.
    const confirmed = await testDb
      .insertInto('reservations')
      .values({
        room_id: casalId,
        room_unit_id: unitA,
        check_in: '2026-09-01',
        check_out: '2026-09-04',
        guests: 2,
        status: 'confirmed',
        total_cents: 30000,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // Cancelled reservation — must NOT be migrated.
    const cancelled = await testDb
      .insertInto('reservations')
      .values({
        room_id: casalId,
        room_unit_id: unitA,
        check_in: '2026-10-01',
        check_out: '2026-10-02',
        guests: 2,
        status: 'cancelled',
        total_cents: 10000,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // First run.
    await sql.raw(EXPAND_RESERVATION_NIGHTS_SQL).execute(testDb);

    const afterFirst = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', confirmed.id)
      .execute();
    expect(afterFirst).toHaveLength(3);

    const cancelledRowsAfterFirst = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', cancelled.id)
      .execute();
    expect(cancelledRowsAfterFirst).toHaveLength(0);

    // Second run — must not throw, must not duplicate, and the internal
    // assert (fresh per-reservation recount) must still pass even though
    // the INSERT itself affects 0 rows this time.
    await expect(sql.raw(EXPAND_RESERVATION_NIGHTS_SQL).execute(testDb)).resolves.not.toThrow();

    const afterSecond = await testDb
      .selectFrom('reservation_nights')
      .selectAll()
      .where('reservation_id', '=', confirmed.id)
      .execute();
    expect(afterSecond).toHaveLength(3);
  });
});
