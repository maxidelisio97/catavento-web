import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import type { EffectivePermissionInput } from './effectivePermissions.js';

/**
 * Builds the input effectivePermissions()/can() need for one user, read
 * fresh on every call (no per-request caching) — a permission or role
 * change must take effect on the user's very next request, not after they
 * log in again.
 */
export async function getEffectivePermissionInput(
  db: Kysely<DB>,
  userId: number,
): Promise<EffectivePermissionInput> {
  const user = await db
    .selectFrom('users')
    .leftJoin('roles', 'roles.id', 'users.role_id')
    .select(['users.role_id', 'roles.is_owner'])
    .where('users.id', '=', userId)
    .executeTakeFirst();

  const roleId = user?.role_id ?? null;
  const roleIsOwner = user?.is_owner ?? false;

  const rolePermissionRows = roleId
    ? await db.selectFrom('role_permissions').select('permission').where('role_id', '=', roleId).execute()
    : [];

  const overrideRows = await db
    .selectFrom('user_permission_overrides')
    .select(['permission', 'granted'])
    .where('user_id', '=', userId)
    .execute();

  return {
    roleIsOwner,
    rolePermissions: new Set(rolePermissionRows.map((row) => row.permission)),
    overrides: new Map(overrideRows.map((row) => [row.permission, row.granted])),
  };
}

export async function getAllPermissionKeys(db: Kysely<DB>): Promise<string[]> {
  const rows = await db.selectFrom('permissions').select('key').execute();
  return rows.map((row) => row.key);
}
