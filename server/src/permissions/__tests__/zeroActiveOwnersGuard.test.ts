/**
 * Explicit proof for the hard safety net in
 * migrations/1784900000000_add-permissions-and-roles.ts (§ 2.4, § 4.6): the
 * migration must never succeed leaving zero active Dueño accounts, because
 * that would be an unrecoverable panel lockout.
 *
 * Executes the EXACT same SQL the migration runs (imported from the shared
 * module, not hand-copied) so this test can never drift from what production
 * actually executes — see zeroActiveOwnersGuardSql.ts.
 */
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { hashPassword } from '../../auth/hashPassword.js';
import { ZERO_ACTIVE_OWNERS_GUARD_SQL } from '../zeroActiveOwnersGuardSql.js';

async function resetDb(): Promise<void> {
  // Never truncate `roles` here — the seeded Dueño/Recepção rows come from
  // the migration itself and other test files rely on them existing (see
  // permissionFixtures.ts). Truncating `users` (cascading to sessions and
  // overrides) is enough to put the whole test database at zero owners,
  // which is exactly the state this guard exists to catch.
  await sql`TRUNCATE TABLE sessions, user_permission_overrides, users RESTART IDENTITY CASCADE`.execute(testDb);
}

async function getDueñoRoleId(): Promise<number> {
  const role = await testDb.selectFrom('roles').select('id').where('is_owner', '=', true).executeTakeFirstOrThrow();
  return role.id;
}

async function insertActiveOwner(): Promise<void> {
  const dueñoRoleId = await getDueñoRoleId();
  await testDb
    .insertInto('users')
    .values({
      email: `${crypto.randomUUID()}@catavento.test`,
      name: 'Active Dueño',
      password_hash: await hashPassword('whatever-not-checked-12345'),
      role_id: dueñoRoleId,
      is_active: true,
    })
    .execute();
}

beforeEach(resetDb);

describe('zero-active-owners migration guard', () => {
  it('throws when the users table would leave zero active Dueño accounts', async () => {
    // resetDb already leaves zero users, i.e. zero active owners.
    await expect(sql.raw(ZERO_ACTIVE_OWNERS_GUARD_SQL).execute(testDb)).rejects.toThrow(
      /zero active Dueño accounts/,
    );
  });

  it('does NOT throw when at least one active Dueño remains', async () => {
    await insertActiveOwner();

    await expect(sql.raw(ZERO_ACTIVE_OWNERS_GUARD_SQL).execute(testDb)).resolves.not.toThrow();
  });

  it('aborts the WHOLE transaction — a write made earlier in the same migration is rolled back too', async () => {
    const dueñoRoleId = await getDueñoRoleId();

    await expect(
      testDb.transaction().execute(async (trx) => {
        // Simulate other work the same migration transaction already did
        // before reaching the guard (e.g. the backfill UPDATEs) — this must
        // not survive if the guard fires.
        await trx
          .insertInto('users')
          .values({
            email: `${crypto.randomUUID()}@catavento.test`,
            name: 'Should be rolled back',
            password_hash: await hashPassword('whatever-not-checked-12345'),
            role_id: dueñoRoleId,
            is_active: false, // inactive — does NOT count as an active owner
          })
          .execute();

        await sql.raw(ZERO_ACTIVE_OWNERS_GUARD_SQL).execute(trx);
      }),
    ).rejects.toThrow(/zero active Dueño accounts/);

    const survivors = await testDb.selectFrom('users').select('id').execute();
    expect(survivors).toHaveLength(0);
  });
});
