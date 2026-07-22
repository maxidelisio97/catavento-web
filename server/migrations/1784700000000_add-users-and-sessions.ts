import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// Approved schema (SPEC-modulo-6-panel-base.md § "ENTREGA 6B — Autenticación
// y scaffold del panel", project owner 2026-07-21): first authenticated
// surface in the system. `users` holds the two hand-created admin accounts;
// `sessions` are opaque server-side sessions (no JWT), chosen because
// "log out everywhere" and immediate revocation are explicit requirements —
// a JWT would still need a revocation list in the database to satisfy those,
// so it wouldn't remove anything and would only add complexity.
export async function up(pgm: MigrationBuilder): Promise<void> {
  // citext: case-insensitive email uniqueness without normalizing manually
  // on every write/read. pgcrypto: gen_random_uuid() for sessions.id.
  pgm.createExtension('citext', { ifNotExists: true });
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  pgm.createTable('users', {
    id: 'id',
    email: { type: 'citext', notNull: true },
    // argon2id hash (via the `argon2` package) — never a raw password, ever.
    password_hash: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    // No permission logic per role in this module (that's M9) — the schema
    // just already distinguishes admin/staff so M9 doesn't need a migration
    // of its own to add the column.
    role: {
      type: 'text',
      notNull: true,
      default: 'admin',
      check: "role IN ('admin','staff')",
    },
    // Login-time kill switch: setting this false must both block new logins
    // and invalidate any sessions already issued (enforced in the session
    // lookup, not just at login) — see auth/sessionRepository.ts.
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('users', 'users_email_unique', { unique: ['email'] });

  pgm.createTable('sessions', {
    id: {
      type: 'uuid',
      notNull: true,
      default: pgm.func('gen_random_uuid()'),
      primaryKey: true,
    },
    // Deviation from the spec's literal "bigint": every FK in this schema
    // targets an 'id' shorthand PK, which is a serial (integer) column — see
    // e.g. reservation_nights.reservation_id. 'integer' here matches that,
    // same reasoning as the 6A migration.
    user_id: {
      type: 'integer',
      notNull: true,
      references: 'users',
      onDelete: 'cascade',
    },
    // SHA-256 hex of the opaque bearer token. The token itself (32 random
    // bytes, base64url) is only ever seen in the Set-Cookie response and in
    // the request cookie header — never persisted in clear text.
    token_hash: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    last_used_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    user_agent: { type: 'text' },
    ip: { type: 'inet' },
    // Non-null means "revoked" — logout and logout-all both just stamp this,
    // they never delete rows (keeps a revocation trail for diagnosis).
    revoked_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('sessions', 'sessions_token_hash_unique', { unique: ['token_hash'] });

  // Partial index: only ever queried for "this user's live sessions" (e.g.
  // logout-all), so indexing revoked rows would be pure waste.
  pgm.createIndex('sessions', 'user_id', {
    name: 'idx_sessions_user_id_active',
    where: 'revoked_at IS NULL',
  });
  pgm.createIndex('sessions', 'expires_at', { name: 'idx_sessions_expires_at' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('sessions');
  pgm.dropTable('users');
  pgm.dropExtension('pgcrypto', { ifExists: true });
  pgm.dropExtension('citext', { ifExists: true });
}
