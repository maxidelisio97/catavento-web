import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// SPEC-modulo-12A-otas-fundaciones-mapeo.md § 3 — deuda técnica anotada en
// 1785400000000_add-channex-room-type-map.ts: `channex_rate_plan_id` nunca
// tuvo su UNIQUE, a diferencia de `channex_room_type_id`. Mismo motivo de
// fondo (1:1, no orphans, § 8): un rate plan de Channex tampoco puede
// quedar reclamado por dos rooms locales. Nullable se mantiene — el
// mapeo puede existir sin rate plan todavía (§ 3), y Postgres no
// considera dos NULLs un duplicado bajo UNIQUE.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addConstraint('channex_room_type_map', 'channex_room_type_map_channex_rate_plan_id_key', {
    unique: 'channex_rate_plan_id',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('channex_room_type_map', 'channex_room_type_map_channex_rate_plan_id_key', { ifExists: true });
}
