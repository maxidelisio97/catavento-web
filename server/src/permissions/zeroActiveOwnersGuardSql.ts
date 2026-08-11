/**
 * The hard safety net used by
 * migrations/1784900000000_add-permissions-and-roles.ts to abort the whole
 * migration transaction if the legacy-role backfill would leave zero active
 * Dueño accounts (SPEC-modulo-9-usuarios-permisos.md § 2.4, § 4.6 — an
 * unrecoverable panel lockout).
 *
 * Extracted into its own module (rather than living only inline in the
 * migration file) so the exact same SQL can be executed a second time from
 * an integration test (see zeroActiveOwnersGuard.test.ts) to prove it really
 * throws — and really rolls back a whole transaction — when zero active
 * owners would remain, without hand-copying the SQL into two places that
 * could drift apart.
 */
export const ZERO_ACTIVE_OWNERS_GUARD_SQL = `
  DO $$
  DECLARE
    owner_count integer;
  BEGIN
    SELECT COUNT(*) INTO owner_count
    FROM users
    JOIN roles ON roles.id = users.role_id
    WHERE roles.is_owner = true AND users.is_active = true;

    IF owner_count = 0 THEN
      RAISE EXCEPTION 'Migration aborted: backfill would leave zero active Dueño accounts.';
    END IF;
  END $$;
`;
