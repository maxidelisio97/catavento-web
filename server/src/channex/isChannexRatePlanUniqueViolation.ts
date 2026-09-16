/**
 * Detects a violation of `channex_room_type_map_channex_rate_plan_id_key`
 * (the UNIQUE(channex_rate_plan_id) added in
 * 1785700000000_add-channex-rate-plan-id-unique.ts — SPEC-modulo-12A-otas-
 * fundaciones-mapeo.md § 3/§ 8: no orphans, no Channex rate plan claimed by
 * two local rooms). Same shape as isChannexRoomTypeUniqueViolation.ts —
 * only a genuine violation of THIS constraint means "already claimed";
 * anything else must surface as a real error.
 */
interface PgUniqueViolation {
  code: string;
  constraint?: string;
}

export function isChannexRatePlanUniqueViolation(err: unknown): err is PgUniqueViolation {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as PgUniqueViolation).code === '23505' &&
    ((err as PgUniqueViolation).constraint?.includes('channex_rate_plan_id') ?? false)
  );
}
