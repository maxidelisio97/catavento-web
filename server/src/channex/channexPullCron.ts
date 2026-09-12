/**
 * SPEC-modulo-12D-robustez-certificacion.md § 1.1 — automated schedule for
 * the Booking Revisions pull. `node-cron` in-process (decision: the backend
 * already runs as a single PM2 process with no external orchestration — a
 * systemd timer would be a second, separate piece of manual deploy for a
 * job that fires every few minutes; this restarts with the same
 * `pm2 restart` already used today).
 *
 * `schedule` is injectable so tests can assert the cron expression and
 * drive the callback by hand — same "no real timers" rule as
 * channexRateLimiter.ts's injectable `now`/`sleep`, applied here to
 * scheduling instead of waiting.
 *
 * § 0.1: this is ONLY the reservations pull (webhook-backup pattern from
 * 12B). Full availability resync stays manual (12C) — Channex certification
 * explicitly forbids putting that on a timer.
 */
import cron from 'node-cron';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { runChannexPull } from './runChannexPull.js';

/** Within Channex's required 15-20 minute range for the reservations pull. */
export const CHANNEX_PULL_CRON_EXPRESSION = '*/15 * * * *';

export interface ScheduledCronTask {
  stop: () => void;
}

export type CronScheduleFn = (expression: string, callback: () => void) => ScheduledCronTask;

export interface ChannexPullCronOptions {
  schedule?: CronScheduleFn;
  /** Called after every tick (success, failure, or skip) — tests hook this instead of racing the schedule. */
  onRunComplete?: (result: Awaited<ReturnType<typeof runChannexPull>>) => void;
  onRunError?: (err: unknown) => void;
}

export function startChannexPullCron(db: Kysely<DB>, options: ChannexPullCronOptions = {}): ScheduledCronTask {
  const scheduleFn = options.schedule ?? ((expression, callback) => cron.schedule(expression, callback));

  return scheduleFn(CHANNEX_PULL_CRON_EXPRESSION, () => {
    runChannexPull(db)
      .then((result) => options.onRunComplete?.(result))
      .catch((err) => options.onRunError?.(err));
  });
}
