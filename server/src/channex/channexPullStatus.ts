/**
 * SPEC-modulo-12D-robustez-certificacion.md § 1.2 — record of the last
 * Booking Revisions pull run. Feeds both the panel indicator (§ 2) and the
 * cron's own success/failure bookkeeping (§ 1.1). Singleton row, same
 * upsert pattern as channexConfig.ts.
 */
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';

export interface ChannexPullStatusRecord {
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
}

export async function getChannexPullStatus(db: Kysely<DB>): Promise<ChannexPullStatusRecord> {
  const row = await db.selectFrom('channex_pull_status').selectAll().where('id', '=', 1).executeTakeFirst();

  return {
    lastRunAt: row?.last_run_at ?? null,
    lastSuccessAt: row?.last_success_at ?? null,
    lastError: row?.last_error ?? null,
  };
}

async function upsertPullStatus(
  db: Kysely<DB>,
  values: { last_run_at: Date; last_success_at?: Date; last_error: string | null },
): Promise<void> {
  await db
    .insertInto('channex_pull_status')
    .values({ id: 1, ...values })
    .onConflict((oc) => oc.column('id').doUpdateSet(values))
    .execute();
}

/** A failed run must never look like a successful one — last_success_at is left untouched. */
export async function recordPullFailure(db: Kysely<DB>, message: string): Promise<void> {
  await upsertPullStatus(db, { last_run_at: new Date(), last_error: message });
}

export async function recordPullSuccess(db: Kysely<DB>): Promise<void> {
  const now = new Date();
  await upsertPullStatus(db, { last_run_at: now, last_success_at: now, last_error: null });
}
