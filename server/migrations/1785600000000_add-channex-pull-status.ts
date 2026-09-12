import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// SPEC-modulo-12D-robustez-certificacion.md § 1.2 — the only record of "when
// did the automated Booking Revisions pull last run" anywhere in the
// project. Singleton row (id pinned to 1, same pattern as channex_config)
// so the cron and the panel indicator always upsert/read the same place,
// no "does a row exist yet" branch.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('channex_pull_status', {
    id: { type: 'smallint', primaryKey: true, default: 1 },
    last_run_at: { type: 'timestamptz' },
    last_success_at: { type: 'timestamptz' },
    last_error: { type: 'text' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('channex_pull_status', 'channex_pull_status_singleton', { check: 'id = 1' });

  pgm.createTrigger('channex_pull_status', 'channex_pull_status_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'set_updated_at',
    level: 'ROW',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger('channex_pull_status', 'channex_pull_status_set_updated_at', { ifExists: true });
  pgm.dropTable('channex_pull_status');
}
