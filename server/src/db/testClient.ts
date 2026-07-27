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

// Exported so concurrency tests can assert that a lock test actually used
// more than one physical connection — otherwise "two requests in parallel"
// could just be pool-queue serialization, which wouldn't exercise the
// `FOR UPDATE` row lock at all.
//
// `options: '-c lock_timeout=5000'` is defensive against a proven failure
// mode, not a performance tweak: vitest's testTimeout aborts the TEST when
// it fires, but does NOT cancel or roll back whatever production-code
// transaction is still in flight server-side (confirmed by hand — see
// server/CLAUDE.md's concurrency-test lesson on this). A test that
// genuinely times out can leave a real row lock held. Without this, the
// NEXT test's beforeEach TRUNCATE waits on that leftover lock until
// Postgres's own deadlock detection kicks in, surfacing as a confusing
// "deadlock detected" on a completely unrelated, otherwise-healthy test.
// 5s is comfortably above every legitimate lock hold in this suite (the
// hand-lock tests release in well under a second) and comfortably below
// vitest.config.ts's testTimeout, so a genuinely abandoned lock fails fast
// and clean — attributable to whichever test is actually blocked — instead
// of cascading into whatever runs next. Passed as a Postgres startup
// parameter (applied by the server before any query runs), not a `SET`
// query fired from the pool's 'connect' event — verified by hand that the
// latter races with the caller's own first query on that same connection
// (pg flags it as a deprecated concurrent client.query() call).
export const testPool = new Pool({ connectionString: testDatabaseUrl, options: '-c lock_timeout=5000' });

const dialect = new PostgresDialect({ pool: testPool });

export const testDb = new Kysely<DB>({ dialect });
