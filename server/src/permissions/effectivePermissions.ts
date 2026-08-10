/**
 * SPEC-modulo-9-usuarios-permisos.md § 2.3, § 2.4, § 4.2 — the pure core of
 * the authorization model. No DB access here on purpose: every branch is
 * exhaustively unit-tested without a database, and the DB-touching lookup
 * that builds this input lives separately (permissionRepository.ts).
 */

export interface EffectivePermissionInput {
  /** True only for the seeded Dueño role — bypasses every check below,
   * including permissions that don't exist yet in rolePermissions (a
   * future module adding a permission must never accidentally exclude the
   * Dueño from it — § 2.4). Never derived from "has every known permission
   * listed", precisely so a new permission can't silently fall outside it. */
  roleIsOwner: boolean;
  /** Permissions granted by the user's role. Empty set if the user has no
   * role assigned (§ 4.2: "sin rol asignado" = zero base permissions, not a
   * rejected/invalid state). */
  rolePermissions: ReadonlySet<string>;
  /** Per-user overrides on top of the role: `true` grants a permission the
   * role doesn't have, `false` revokes one the role does have. Ignored
   * entirely when roleIsOwner is true (§ 2.4: overrides can't take anything
   * away from a Dueño). */
  overrides: ReadonlyMap<string, boolean>;
}

/** Single-permission check — the hot path used by requirePermission. */
export function can(input: EffectivePermissionInput, permission: string): boolean {
  if (input.roleIsOwner) return true;

  const override = input.overrides.get(permission);
  if (override !== undefined) return override;

  return input.rolePermissions.has(permission);
}

/**
 * Full effective set — used by GET /panel/me/permissions, where the
 * frontend needs to know everything the user can do, not just answer one
 * permission at a time. `allPermissionKeys` is the full catalog (from the
 * `permissions` table) so a Dueño's effective set reflects permissions added
 * after this user's role/overrides were last touched.
 */
export function effectivePermissions(
  input: EffectivePermissionInput,
  allPermissionKeys: readonly string[],
): Set<string> {
  if (input.roleIsOwner) return new Set(allPermissionKeys);

  const result = new Set(input.rolePermissions);
  for (const [permission, granted] of input.overrides) {
    if (granted) {
      result.add(permission);
    } else {
      result.delete(permission);
    }
  }
  return result;
}
