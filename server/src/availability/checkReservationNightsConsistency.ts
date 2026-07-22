/**
 * Invariant check, per SPEC-modulo-6-panel-base.md § "6A.3 Invariante:
 * prohibido una noche activa sin unidad".
 *
 * Finds active reservations (per `isReservationActive`) whose
 * `reservation_nights` row count doesn't match their expected night count
 * (`check_out - check_in`) — including reservations with zero rows (no unit
 * assigned to any night) or with extra rows (more nights than the stay
 * actually spans).
 *
 * Kept as a plain function over a `Kysely<DB>` executor (not an HTTP
 * endpoint — no auth/panel infrastructure exists yet, that's módulo 6B) so
 * it can be:
 * - run from integration tests directly against `catavento_db_test`,
 * - run manually via the `scripts/checkReservationNightsConsistency.ts` CLI
 *   wrapper for diagnostics,
 * - asserted per-reservation at the end of any transaction that touches
 *   reservations (`assertReservationNightsConsistency` below) — the
 *   application-layer half of the invariant that § 6A.3 asks for. Without
 *   this, a bug like confirmPendingReservation.ts's caso límite (confirming
 *   a reservation whose reservation_nights rows were swept away by a
 *   concurrent createReservation) would leave a crippled reservation
 *   silently instead of failing loudly.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../db/types.js';
import { isReservationActive } from './isReservationActive.js';

export class ReservationNightsInvariantError extends Error {
  constructor(
    readonly reservationId: number,
    readonly code: string | null,
    readonly expectedNights: number,
    readonly actualNights: number,
  ) {
    super(
      `Reservation ${reservationId}${code ? ` (${code})` : ''} is active with ${actualNights} reservation_nights row(s), expected ${expectedNights}`,
    );
  }
}

/**
 * Per-reservation invariant assert, meant to run inside the SAME
 * transaction that just wrote to `reservations`/`reservation_nights`, right
 * before it commits. No-ops for a reservation that isn't currently active —
 * the invariant only constrains active reservations.
 */
export async function assertReservationNightsConsistency(
  trx: Transaction<DB>,
  reservationId: number,
): Promise<void> {
  const reservation = await trx
    .selectFrom('reservations')
    .select([
      'id',
      'code',
      'status',
      'expires_at',
      sql<string>`check_in::text`.as('check_in'),
      sql<string>`check_out::text`.as('check_out'),
    ])
    .where('id', '=', reservationId)
    .executeTakeFirstOrThrow();

  if (!isReservationActive(reservation.status, reservation.expires_at)) return;

  const expectedNights =
    (new Date(reservation.check_out).getTime() - new Date(reservation.check_in).getTime()) / (1000 * 60 * 60 * 24);

  const row = await trx
    .selectFrom('reservation_nights')
    .select(({ fn }) => fn.countAll().as('count'))
    .where('reservation_id', '=', reservationId)
    .executeTakeFirstOrThrow();

  const actualNights = Number(row.count);

  if (actualNights !== expectedNights) {
    throw new ReservationNightsInvariantError(reservation.id, reservation.code, expectedNights, actualNights);
  }
}

export interface ReservationNightsInconsistency {
  reservationId: number;
  code: string | null;
  expectedNights: number;
  actualNights: number;
}

export async function checkReservationNightsConsistency(
  db: Kysely<DB>,
): Promise<ReservationNightsInconsistency[]> {
  const reservations = await db
    .selectFrom('reservations')
    .select([
      'id',
      'code',
      'status',
      'expires_at',
      sql<string>`check_in::text`.as('check_in'),
      sql<string>`check_out::text`.as('check_out'),
    ])
    .where('status', '!=', 'cancelled')
    .execute();

  const activeReservations = reservations.filter((r) => isReservationActive(r.status, r.expires_at));
  if (activeReservations.length === 0) return [];

  const nightCounts = await db
    .selectFrom('reservation_nights')
    .select(['reservation_id', ({ fn }) => fn.countAll().as('count')])
    .where(
      'reservation_id',
      'in',
      activeReservations.map((r) => r.id),
    )
    .groupBy('reservation_id')
    .execute();

  const actualByReservationId = new Map<number, number>(
    nightCounts.map((row) => [row.reservation_id, Number(row.count)]),
  );

  const inconsistencies: ReservationNightsInconsistency[] = [];

  for (const reservation of activeReservations) {
    const expectedNights =
      (new Date(reservation.check_out).getTime() - new Date(reservation.check_in).getTime()) / (1000 * 60 * 60 * 24);
    const actualNights = actualByReservationId.get(reservation.id) ?? 0;

    if (actualNights !== expectedNights) {
      inconsistencies.push({
        reservationId: reservation.id,
        code: reservation.code,
        expectedNights,
        actualNights,
      });
    }
  }

  return inconsistencies;
}
