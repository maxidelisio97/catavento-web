/**
 * SPEC-modulo-12D-robustez-certificacion.md § 1/§ 5 — the entry point both
 * the cron (channexPullCron.ts) and the panel's manual "buscar reservas
 * agora" button (panelChannex.ts's POST /panel/channex/pull-now) call to run
 * one Booking Revisions pull with bookkeeping. Wraps pullBookingRevisions
 * (12B) with two things it doesn't have on its own: a lock against running
 * in parallel with itself, and a record of the outcome. Both callers go
 * through the SAME lock (`runChannexPullLocked`) — § 5 requires the manual
 * button and the cron to never step on each other, and that's only true if
 * neither path can reach `pullBookingRevisions` without it.
 *
 * Lock: `pg_try_advisory_lock` on a single fixed, negative key — negative
 * because every other advisory lock in this codebase
 * (createOrReusePayment.ts) is keyed by a `reservation_id`, always a
 * positive serial int. A negative key can never collide with one of those,
 * so this reservation is safe without coordinating key ranges by hand.
 * `pg_try_advisory_lock` (non-blocking) is deliberate over
 * `pg_advisory_xact_lock` (blocking): if the cron fires while a run is
 * already in progress (manual trigger or the cron's own previous tick
 * running long), the right behavior is to skip this tick cleanly, not to
 * queue up and fire back-to-back once the first finishes.
 *
 * The lock is taken on a connection checked out via `db.connection()` and
 * held for the whole pull (session-scoped, not transaction-scoped, since
 * pullBookingRevisions runs its own per-item transactions) — released in a
 * `finally` so a thrown error can never leak a held lock.
 */
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { getChannexConfig } from './channexConfig.js';
import { pullBookingRevisions, type PullBookingRevisionsResult } from './pullBookingRevisions.js';
import { recordPullFailure, recordPullSuccess } from './channexPullStatus.js';

export const CHANNEX_PULL_LOCK_KEY = -915001;

export type RunChannexPullResult =
  | { kind: 'skipped_not_configured' }
  | { kind: 'skipped_locked' }
  | { kind: 'success'; result: PullBookingRevisionsResult }
  | { kind: 'failed'; message: string };

export type RunChannexPullLockedResult = Exclude<RunChannexPullResult, { kind: 'skipped_not_configured' }>;

/** Called by BOTH the cron and the manual pull-now endpoint — see module docstring. */
export async function runChannexPullLocked(db: Kysely<DB>, propertyId: string): Promise<RunChannexPullLockedResult> {
  return db.connection().execute(async (conn) => {
    const lockRow = await sql<{ locked: boolean }>`select pg_try_advisory_lock(${CHANNEX_PULL_LOCK_KEY}) as locked`.execute(
      conn,
    );
    if (!lockRow.rows[0]?.locked) {
      return { kind: 'skipped_locked' };
    }

    try {
      const result = await pullBookingRevisions(conn, propertyId);
      await recordPullSuccess(conn);
      return { kind: 'success', result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      await recordPullFailure(conn, message);
      return { kind: 'failed', message };
    } finally {
      await sql`select pg_advisory_unlock(${CHANNEX_PULL_LOCK_KEY})`.execute(conn);
    }
  });
}

/**
 * Cron entry point: also gates on `isActive` (like pushAvailability.ts's
 * automated pushes do) since this fires unattended — a disconnected/paused
 * integration shouldn't have the cron hammering Channex every 15 minutes.
 * The manual pull-now button is a deliberate human action instead, so it
 * calls `runChannexPullLocked` directly and keeps its existing
 * propertyId-only gate (unchanged behavior, see panelChannex.ts).
 */
export async function runChannexPull(db: Kysely<DB>): Promise<RunChannexPullResult> {
  const current = await getChannexConfig(db);
  if (!current.propertyId || !current.isActive) {
    return { kind: 'skipped_not_configured' };
  }

  return runChannexPullLocked(db, current.propertyId);
}
