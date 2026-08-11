import { createHash, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { hashPassword } from '../auth/hashPassword.js';

/**
 * Existing M7/M8 panel test fixtures create a plain session-holding user
 * with no role assigned. Once requirePermission is wired into those
 * endpoints, such a user would get 403'd (§ 4.2: sin rol = sin permisos) —
 * breaking tests that were never about authorization, only about the
 * business logic those endpoints already had. Assigning the seeded Dueño
 * role (is_owner bypasses every permission check, see effectivePermissions.ts)
 * to those fixtures keeps them testing what they've always tested.
 *
 * Relies on the migration's seed — never truncate `roles` in a test file
 * that runs in the same shared test database as everything else (see
 * requirePermission.test.ts's resetDb comment).
 */
export async function getDueñoRoleId(db: Kysely<DB>): Promise<number> {
  const role = await db.selectFrom('roles').select('id').where('is_owner', '=', true).executeTakeFirstOrThrow();
  return role.id;
}

/**
 * Creates a non-owner, non-system role with exactly the given permissions —
 * for the "sin permiso -> 403, con permiso -> 200" pair each gated endpoint
 * needs (§ 7). Relies on the migration's seeded `permissions` catalog
 * already containing every key used here.
 */
export async function createRoleWithPermissions(
  db: Kysely<DB>,
  permissions: string[] = [],
): Promise<number> {
  const role = await db
    .insertInto('roles')
    .values({ name: crypto.randomUUID(), is_owner: false })
    .returning('id')
    .executeTakeFirstOrThrow();

  for (const permission of permissions) {
    await db.insertInto('role_permissions').values({ role_id: role.id, permission }).execute();
  }

  return role.id;
}

/** A throwaway user + live session cookie, with an arbitrary (or no) role. */
export async function createSessionCookieForRole(db: Kysely<DB>, roleId: number | null): Promise<string> {
  const user = await db
    .insertInto('users')
    .values({
      email: `${crypto.randomUUID()}@catavento.test`,
      name: 'Test User',
      password_hash: await hashPassword('whatever-not-checked-12345'),
      role_id: roleId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await db
    .insertInto('sessions')
    .values({ user_id: user.id, token_hash: tokenHash, expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) })
    .execute();

  return token;
}
