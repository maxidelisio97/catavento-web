import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../db/types.js';

type Queryable = Kysely<DB> | Transaction<DB>;

/**
 * SPEC-modulo-9-usuarios-permisos.md § 2.4 — the anti-self-lockout guard.
 * "Active owner" = a user with is_active=true whose role has is_owner=true.
 * Every caller that could reduce this set to zero (role change, deactivate)
 * must run this INSIDE the same transaction that performs the change, with
 * this count taken via FOR UPDATE so two concurrent demotions of the last
 * two owners can't both read "2 owners, safe" and both proceed.
 */
export async function countActiveOwners(trx: Queryable): Promise<number> {
  const rows = await trx
    .selectFrom('users')
    .innerJoin('roles', 'roles.id', 'users.role_id')
    .select('users.id')
    .where('roles.is_owner', '=', true)
    .where('users.is_active', '=', true)
    .forUpdate()
    .execute();
  return rows.length;
}

export async function isCurrentlyActiveOwner(trx: Queryable, userId: number): Promise<boolean> {
  const row = await trx
    .selectFrom('users')
    .leftJoin('roles', 'roles.id', 'users.role_id')
    .select(['roles.is_owner', 'users.is_active'])
    .where('users.id', '=', userId)
    .executeTakeFirst();
  return Boolean(row?.is_owner && row.is_active);
}

export async function isOwnerRole(trx: Queryable, roleId: number | null): Promise<boolean> {
  if (roleId === null) return false;
  const role = await trx.selectFrom('roles').select('is_owner').where('id', '=', roleId).executeTakeFirst();
  return Boolean(role?.is_owner);
}

export class LastOwnerLockoutError extends Error {
  constructor() {
    super('This operation would leave zero active Dueño accounts.');
  }
}

/**
 * Call inside the same transaction as the write, AFTER locking the active
 * owner rows via countActiveOwners but BEFORE applying the change. Throws
 * if `userId` is currently the only active owner and `willRemainActiveOwner`
 * is false (i.e. this change would demote/deactivate them).
 */
export async function assertNotLastOwnerLockout(
  trx: Queryable,
  userId: number,
  willRemainActiveOwner: boolean,
): Promise<void> {
  const wasActiveOwner = await isCurrentlyActiveOwner(trx, userId);
  if (!wasActiveOwner || willRemainActiveOwner) return;

  const totalActiveOwners = await countActiveOwners(trx);
  if (totalActiveOwners <= 1) {
    throw new LastOwnerLockoutError();
  }
}
