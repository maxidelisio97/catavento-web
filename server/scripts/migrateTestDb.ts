/**
 * Applies migrations to catavento_db_test — never catavento_db. Separate
 * from `migrate:up` (which targets `DATABASE_URL`, i.e. production/dev) so
 * running tests locally never depends on a developer remembering to swap
 * env vars by hand.
 */
import 'dotenv/config';
import { runner } from 'node-pg-migrate';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is not set.');
}
const testDatabaseName = new URL(testDatabaseUrl).pathname.replace(/^\//, '');
if (!testDatabaseName.endsWith('_test')) {
  throw new Error(`Refusing to migrate: "${testDatabaseName}" does not end in "_test".`);
}

await runner({
  databaseUrl: testDatabaseUrl,
  dir: 'migrations',
  direction: 'up',
  migrationsTable: 'pgmigrations',
  checkOrder: true,
});
