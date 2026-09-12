/**
 * SPEC-modulo-12D-robustez-certificacion.md § 1/§ 5. `fetchBookingRevisionsFeed`
 * is mocked (same pattern as panelChannex.test.ts) so the concurrency test can
 * control exactly when the "in Channex" part of a run resolves — a real
 * network call wouldn't give a deterministic overlap window.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { getChannexPullStatus } from '../channexPullStatus.js';

const { fetchBookingRevisionsFeed, ackBookingRevision } = vi.hoisted(() => ({
  fetchBookingRevisionsFeed: vi.fn(),
  ackBookingRevision: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../channexClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channexClient.js')>();
  return { ...actual, fetchBookingRevisionsFeed, ackBookingRevision };
});

const { runChannexPull, runChannexPullLocked } = await import('../runChannexPull.js');

const PROPERTY_ID = 'f6a1bdf1-cef7-4e16-bc4e-a4799510d23f';

async function setChannexConfig(overrides: { propertyId?: string | null; isActive?: boolean } = {}) {
  await testDb
    .insertInto('channex_config')
    .values({
      id: 1,
      environment: 'staging',
      property_id: overrides.propertyId === undefined ? PROPERTY_ID : overrides.propertyId,
      is_active: overrides.isActive ?? true,
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        property_id: overrides.propertyId === undefined ? PROPERTY_ID : overrides.propertyId,
        is_active: overrides.isActive ?? true,
      }),
    )
    .execute();
}

beforeEach(async () => {
  await testDb.deleteFrom('channex_config').execute();
  await testDb.deleteFrom('channex_pull_status').execute();
  fetchBookingRevisionsFeed.mockReset();
  ackBookingRevision.mockClear();
});

describe('runChannexPull', () => {
  it('skips cleanly when no property_id is configured, without touching the status record', async () => {
    const result = await runChannexPull(testDb);

    expect(result).toEqual({ kind: 'skipped_not_configured' });
    expect(fetchBookingRevisionsFeed).not.toHaveBeenCalled();
    expect(await getChannexPullStatus(testDb)).toEqual({ lastRunAt: null, lastSuccessAt: null, lastError: null });
  });

  it('skips cleanly when the connection is configured but inactive', async () => {
    await setChannexConfig({ isActive: false });

    const result = await runChannexPull(testDb);

    expect(result).toEqual({ kind: 'skipped_not_configured' });
    expect(fetchBookingRevisionsFeed).not.toHaveBeenCalled();
  });

  it('on success, pulls the feed and records last_run_at + last_success_at, clears last_error', async () => {
    await setChannexConfig();
    fetchBookingRevisionsFeed.mockResolvedValueOnce([]);

    const result = await runChannexPull(testDb);

    expect(result.kind).toBe('success');
    const status = await getChannexPullStatus(testDb);
    expect(status.lastSuccessAt).toBeInstanceOf(Date);
    expect(status.lastError).toBeNull();
  });

  it('on failure, records last_run_at + last_error and must NOT set last_success_at', async () => {
    await setChannexConfig();
    fetchBookingRevisionsFeed.mockRejectedValueOnce(new Error('Channex respondeu 503'));

    const result = await runChannexPull(testDb);

    expect(result).toEqual({ kind: 'failed', message: 'Channex respondeu 503' });
    const status = await getChannexPullStatus(testDb);
    expect(status.lastRunAt).toBeInstanceOf(Date);
    expect(status.lastSuccessAt).toBeNull();
    expect(status.lastError).toBe('Channex respondeu 503');
  });

  it('two overlapping runs never process the feed twice at once: the second skips via the advisory lock', async () => {
    await setChannexConfig();

    // Deferred so the first call's "in Channex" step stays open long enough
    // for the second call to attempt (and fail) its own lock acquisition —
    // deterministic overlap without a real network call or a sleep.
    let releaseFirstFetch!: () => void;
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    fetchBookingRevisionsFeed.mockImplementationOnce(async () => {
      await firstFetchGate;
      return [];
    });
    fetchBookingRevisionsFeed.mockResolvedValueOnce([]);

    const firstRun = runChannexPull(testDb);

    // Give the first call time to acquire the lock and reach the (still
    // gated) fetch before starting the second.
    await vi.waitFor(() => expect(fetchBookingRevisionsFeed).toHaveBeenCalledTimes(1));

    const secondRun = runChannexPull(testDb);
    const secondResult = await secondRun;
    expect(secondResult).toEqual({ kind: 'skipped_locked' });

    releaseFirstFetch();
    const firstResult = await firstRun;
    expect(firstResult.kind).toBe('success');

    // Removing the lock (verified by hand: swapping pg_try_advisory_lock for
    // an always-true stub) makes this same scenario call
    // fetchBookingRevisionsFeed twice concurrently instead of skipping —
    // confirming this test actually exercises the lock, not incidental
    // sequencing.
    expect(fetchBookingRevisionsFeed).toHaveBeenCalledTimes(1);
  });
});

describe('runChannexPullLocked (used directly by the manual pull-now endpoint)', () => {
  it('runs even when is_active is false — the manual button is a deliberate human action, unlike the cron', async () => {
    await setChannexConfig({ isActive: false });
    fetchBookingRevisionsFeed.mockResolvedValueOnce([]);

    const result = await runChannexPullLocked(testDb, PROPERTY_ID);

    expect(result.kind).toBe('success');
    expect(fetchBookingRevisionsFeed).toHaveBeenCalledTimes(1);
  });

  it('shares the same lock as runChannexPull — a manual call blocks a concurrent cron tick', async () => {
    await setChannexConfig();

    let releaseFirstFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    fetchBookingRevisionsFeed.mockImplementationOnce(async () => {
      await gate;
      return [];
    });
    fetchBookingRevisionsFeed.mockResolvedValueOnce([]);

    const manualRun = runChannexPullLocked(testDb, PROPERTY_ID);
    await vi.waitFor(() => expect(fetchBookingRevisionsFeed).toHaveBeenCalledTimes(1));

    const cronRun = runChannexPull(testDb);
    expect(await cronRun).toEqual({ kind: 'skipped_locked' });

    releaseFirstFetch();
    expect((await manualRun).kind).toBe('success');
  });
});
