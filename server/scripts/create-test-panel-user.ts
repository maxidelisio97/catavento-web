import { db } from '../src/db/client.js';
import { hashPassword } from '../src/auth/hashPassword.js';
import { config } from '../src/config.js';

/**
 * One-off helper for local SPEC-modulo-12C staging verification — creates
 * (or resets) a Dueño-role panel user in whatever database DATABASE_URL
 * currently points to. Bypasses every permission check per
 * effectivePermissions.ts (Dueño role), same fixture pattern
 * test-support/permissionFixtures.ts uses for automated tests.
 *
 * SAFETY: run this ONLY with DATABASE_URL overridden to TEST_DATABASE_URL
 * for THIS session (server/CLAUDE.md's "Verificación manual" convention).
 * The check below is a guard, not a guarantee — it only catches the most
 * common mistake (an unset override), not a TEST_DATABASE_URL that happens
 * to also contain "catavento_db_test" as a substring of something else.
 *
 * Usage: npx tsx scripts/create-test-panel-user.ts <email> <password>
 */
const email = process.argv[2];
const password = process.argv[3];

if (!email || !password || password.length < 8) {
  console.error('Usage: npx tsx scripts/create-test-panel-user.ts <email> <password (min 8 chars)>');
  process.exit(1);
}

if (!config.databaseUrl.includes('catavento_db_test')) {
  console.error('Refusing to run: DATABASE_URL does not look like the test database (catavento_db_test).');
  console.error('Set it first: $env:DATABASE_URL = (Get-Content .env | Where-Object { $_ -match \'^TEST_DATABASE_URL=\' }) -replace \'^TEST_DATABASE_URL=\', \'\'');
  process.exit(1);
}

async function main(): Promise<void> {
  const role = await db.selectFrom('roles').select('id').where('is_owner', '=', true).executeTakeFirstOrThrow();
  const passwordHash = await hashPassword(password);

  const user = await db
    .insertInto('users')
    .values({
      email: email.toLowerCase(),
      name: 'Test Owner',
      password_hash: passwordHash,
      role_id: role.id,
      is_active: true,
      must_change_password: false,
    })
    .onConflict((oc) =>
      oc.column('email').doUpdateSet({
        password_hash: passwordHash,
        role_id: role.id,
        is_active: true,
        must_change_password: false,
      }),
    )
    .returning(['id', 'email'])
    .executeTakeFirstOrThrow();

  console.log(`OK: ${user.email} (id ${user.id}, Dueño role)`);
}

main()
  .then(() => db.destroy())
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    return db.destroy().finally(() => process.exit(1));
  });
