import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// SPEC-modulo-9-usuarios-permisos.md § 4.1, § 4.6 — authorization model on
// top of M6B's authentication. `permissions` is a data table (not an enum
// hardcoded in application code) so a future module can add a permission by
// inserting a row, never by touching the check mechanism itself.
//
// `roles.is_owner` (not just "has every permission listed in
// role_permissions") is what lets the Dueño role bypass every check,
// including permissions that don't exist yet at seed time — see
// effectivePermissions.ts. `is_system` still exists separately to mark a
// role as non-deletable in general (both seeded roles are `is_system`, only
// Dueño is also `is_owner`).
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('permissions', {
    key: { type: 'text', primaryKey: true },
    description: { type: 'text', notNull: true },
  });

  pgm.createTable('roles', {
    id: 'id',
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    is_system: { type: 'boolean', notNull: true, default: false },
    is_owner: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('roles', 'roles_name_unique', { unique: ['name'] });

  // PK (role_id, permission) already indexes lookups by role_id (leftmost
  // column) — no separate index needed per server/CLAUDE.md's
  // rendimiento-y-consultas rule.
  pgm.createTable('role_permissions', {
    role_id: { type: 'integer', notNull: true, references: 'roles', onDelete: 'cascade' },
    permission: { type: 'text', notNull: true, references: 'permissions' },
  });
  pgm.addConstraint('role_permissions', 'role_permissions_pkey', {
    primaryKey: ['role_id', 'permission'],
  });

  // Nullable: "sin rol asignado" is a real, handled state (effectivePermissions
  // treats it as zero base permissions), not an invariant violation.
  pgm.addColumn('users', {
    role_id: { type: 'integer', references: 'roles', onDelete: 'SET NULL' },
    // Forces a password change on next authenticated request (enforced by
    // blockIfMustChangePassword, wired in the same entrega) — set true when
    // an admin sets an employee's first password via POST /panel/users.
    must_change_password: { type: 'boolean', notNull: true, default: false },
  });

  // PK (user_id, permission) already indexes lookups by user_id.
  pgm.createTable('user_permission_overrides', {
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'cascade' },
    permission: { type: 'text', notNull: true, references: 'permissions' },
    granted: { type: 'boolean', notNull: true },
  });
  pgm.addConstraint('user_permission_overrides', 'user_permission_overrides_pkey', {
    primaryKey: ['user_id', 'permission'],
  });

  // Seed: the permission catalog from § 2.1. Extensible by future modules —
  // this list is the M9 baseline, not meant to be exhaustive forever.
  pgm.sql(`
    INSERT INTO permissions (key, description) VALUES
      ('reservations.view', 'Ver tape chart e detalhes de reservas'),
      ('reservations.create_manual', 'Criar reserva manual'),
      ('reservations.move', 'Mover reserva de unidade (move-night / move-stay)'),
      ('reservations.checkin', 'Fazer check-in'),
      ('reservations.checkout', 'Fazer check-out'),
      ('reservations.cancel', 'Cancelar reserva / marcar no-show'),
      ('payments.charge', 'Registrar pagamentos (depósito / saldo)'),
      ('payments.extra', 'Adicionar cobranças extras'),
      ('config.settings', 'Editar configurações e preços base'),
      ('config.calendar', 'Editar calendário de overrides'),
      ('admin.users', 'Gerenciar usuários (criar, editar, desativar, atribuir papel/overrides)'),
      ('admin.roles', 'Gerenciar papéis (criar, editar, excluir)');
  `);

  // Seed: Dueño (bypasses everything, see is_owner above) and Recepção
  // (starts with zero permissions — § 2.2: "no se asumen permisos por
  // defecto, el dueño los asigna").
  pgm.sql(`
    INSERT INTO roles (name, description, is_system, is_owner) VALUES
      ('Dueño', 'Acesso total, não editável nem removível', true, true),
      ('Recepção', 'Papel editável — permissões atribuídas pelo Dueño', true, false);
  `);

  // Backfill (§ 4.6, the most delicate part of this deploy): every account
  // that exists today was hand-created via scripts/create-user.ts, which
  // only ever sets the legacy `role` text column to 'admin' — there is no
  // 'staff' account in production as of this migration (verified by hand
  // against catavento_db before writing this migration). Mapping legacy
  // 'admin' -> Dueño keeps every existing account able to administer the
  // panel after this migration runs; legacy 'staff' -> Recepção is the
  // closest equivalent, included for completeness even though no such row
  // exists today.
  pgm.sql(`
    UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'Dueño')
    WHERE role = 'admin';
  `);
  pgm.sql(`
    UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'Recepção')
    WHERE role = 'staff';
  `);

  // Hard safety net: never let this migration succeed silently if it would
  // leave zero active Dueño accounts — that would be an unrecoverable panel
  // lockout (§ 2.4). Aborts the whole migration transaction instead.
  pgm.sql(`
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
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('user_permission_overrides');
  pgm.dropColumn('users', ['role_id', 'must_change_password']);
  pgm.dropTable('role_permissions');
  pgm.dropTable('roles');
  pgm.dropTable('permissions');
}
