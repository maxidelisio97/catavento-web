import 'dotenv/config';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from './types.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is not set — tests must never run against catavento_db.');
}

// Hard guard, enforced by code rather than convention: refuse to hand out a
// db client for tests unless the target database name ends in "_test". This
// is what actually stops a misconfigured .env from ever letting a test
// TRUNCATE production data — see server/CLAUDE.md § Verificación.
const testDatabaseName = new URL(testDatabaseUrl).pathname.replace(/^\//, '');
if (!testDatabaseName.endsWith('_test')) {
  throw new Error(
    `Refusing to connect: TEST_DATABASE_URL points to database "${testDatabaseName}", ` +
      'which does not end in "_test". Tests must never run against a non-test database.',
  );
}

const dialect = new PostgresDialect({
  pool: new Pool({ connectionString: testDatabaseUrl }),
});

export const testDb = new Kysely<DB>({ dialect });
