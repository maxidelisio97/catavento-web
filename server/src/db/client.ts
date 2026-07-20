import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { config } from '../config.js';
import type { DB } from './types.js';

const dialect = new PostgresDialect({
  pool: new Pool({
    connectionString: config.databaseUrl,
  }),
});

export const db = new Kysely<DB>({ dialect });
