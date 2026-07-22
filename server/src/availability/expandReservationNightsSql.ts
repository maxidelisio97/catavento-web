/**
 * The idempotent data-migration SQL used by
 * migrations/1784671660831_add-reservation-nights-and-origin.ts to expand
 * pre-6A active reservations into `reservation_nights` rows.
 *
 * Extracted into its own module (rather than living only inline in the
 * migration file) so the exact same SQL can be executed a second time from
 * an integration test (see reservationNightsMigration.test.ts) to prove the
 * re-run safety claimed in SPEC-modulo-6-panel-base.md § "6A.1: la
 * migración debe poder correrse dos veces sin efecto adicional" — without
 * hand-copying the SQL into two places that could drift apart.
 *
 * See the migration file for the full rationale, in particular why the
 * post-migration assert is a FRESH per-reservation `count(*)` against
 * `reservation_nights`, never the INSERT statement's own affected-row
 * count (which is 0 on every re-run once rows already exist).
 */
export const EXPAND_RESERVATION_NIGHTS_SQL = `
  DO $$
  DECLARE
    mismatch_count integer;
  BEGIN
    INSERT INTO reservation_nights (reservation_id, night, room_unit_id)
    SELECT
      r.id,
      gs.night::date,
      r.room_unit_id
    FROM reservations r
    CROSS JOIN LATERAL generate_series(r.check_in, r.check_out - INTERVAL '1 day', INTERVAL '1 day') AS gs(night)
    WHERE r.room_unit_id IS NOT NULL
      AND (
        r.status = 'confirmed'
        OR (r.status = 'pending_payment' AND r.expires_at IS NOT NULL AND r.expires_at > now())
        OR (r.status = 'pending_payment' AND r.expires_at IS NULL)
      )
    ON CONFLICT (reservation_id, night) DO NOTHING;

    SELECT count(*) INTO mismatch_count
    FROM (
      SELECT
        r.id,
        (r.check_out - r.check_in) AS expected_nights,
        (SELECT count(*) FROM reservation_nights rn WHERE rn.reservation_id = r.id) AS actual_nights
      FROM reservations r
      WHERE r.room_unit_id IS NOT NULL
        AND (
          r.status = 'confirmed'
          OR (r.status = 'pending_payment' AND r.expires_at IS NOT NULL AND r.expires_at > now())
          OR (r.status = 'pending_payment' AND r.expires_at IS NULL)
        )
    ) counts
    WHERE counts.expected_nights <> counts.actual_nights;

    IF mismatch_count > 0 THEN
      RAISE EXCEPTION 'reservation_nights data migration mismatch: % active reservation(s) with a row count that does not match their expected night count', mismatch_count;
    END IF;
  END $$;
`;
