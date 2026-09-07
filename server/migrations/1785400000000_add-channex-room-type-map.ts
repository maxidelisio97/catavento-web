import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// SPEC-modulo-12A-otas-fundaciones-mapeo.md § 3 — associates each local room
// type (rooms.id) to the Channex Room Type/Rate Plan UUIDs that already
// exist in Channex (12A never creates them via API, § 2/§ 8). 1:1 mapping,
// enforced by both UNIQUE constraints — a Channex room type can't be claimed
// by two local rooms, and a local room can't be mapped twice.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('channex_room_type_map', {
    id: 'id',
    room_id: {
      type: 'integer',
      notNull: true,
      references: 'rooms',
      onDelete: 'CASCADE',
      unique: true,
    },
    channex_room_type_id: { type: 'uuid', notNull: true, unique: true },
    // Nullable per § 3: the room type mapping can exist before its rate plan
    // is chosen — "mapeo completo" (checked by mapping-status) requires both.
    channex_rate_plan_id: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTrigger('channex_room_type_map', 'channex_room_type_map_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'set_updated_at',
    level: 'ROW',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger('channex_room_type_map', 'channex_room_type_map_set_updated_at', { ifExists: true });
  pgm.dropTable('channex_room_type_map');
}
