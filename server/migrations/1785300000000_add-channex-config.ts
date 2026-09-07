import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// SPEC-modulo-12A-otas-fundaciones-mapeo.md § 3, § 7 — connection config to
// Channex (channel manager). `channex_config` is a singleton row (id pinned
// to 1 via CHECK) so the app can always upsert onto it without a separate
// "does a row exist yet" branch, same idea as a settings table but with
// typed columns per § 3's explicit shape. The API key itself is NEVER a
// column here (§ 4) — it lives only in CHANNEX_API_KEY, same pattern as
// Asaas's ASAAS_API_KEY (see src/config.ts).
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('channex_config', {
    id: { type: 'smallint', primaryKey: true, default: 1 },
    environment: {
      type: 'text',
      notNull: true,
      default: 'staging',
      check: "environment IN ('staging', 'production')",
    },
    property_id: { type: 'uuid' },
    is_active: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('channex_config', 'channex_config_singleton', { check: 'id = 1' });

  pgm.createTrigger('channex_config', 'channex_config_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'set_updated_at',
    level: 'ROW',
  });

  // Seed: new permission for M12 (§ 7), same data-driven pattern as the M9
  // catalog — extends it, doesn't touch the check mechanism.
  pgm.sql(`
    INSERT INTO permissions (key, description) VALUES
      ('ota.manage', 'Configurar conexão com OTAs (Channex) e gerenciar o mapeamento de tipos de quarto');
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DELETE FROM permissions WHERE key = 'ota.manage'`);
  pgm.dropTrigger('channex_config', 'channex_config_set_updated_at', { ifExists: true });
  pgm.dropTable('channex_config');
}
