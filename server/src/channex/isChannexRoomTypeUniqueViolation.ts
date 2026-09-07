/**
 * Detects a violation of `channex_room_type_map_channex_room_type_id_key`
 * (the UNIQUE(channex_room_type_id) that keeps the mapping 1:1 — SPEC-modulo-
 * 12A-otas-fundaciones-mapeo.md § 3/§ 8: no orphans, no Channex room type
 * claimed by two local rooms). Same shape as
 * availability/isUnitNightUniqueViolation.ts — only a genuine violation of
 * THIS constraint means "already claimed"; anything else must surface as a
 * real error.
 */
interface PgUniqueViolation {
  code: string;
  constraint?: string;
}

export function isChannexRoomTypeUniqueViolation(err: unknown): err is PgUniqueViolation {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as PgUniqueViolation).code === '23505' &&
    ((err as PgUniqueViolation).constraint?.includes('channex_room_type_id') ?? false)
  );
}
