/**
 * SPEC-modulo-12D § 1.1/§ 5 — "el cron corre en el intervalo esperado". No
 * real timers (server/CLAUDE.md's test-determinism rule, same as
 * channexRateLimiter.test.ts): `schedule` is injected, so this asserts the
 * cron expression it's registered with and drives its callback by hand,
 * instead of waiting real minutes for node-cron to fire.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { CHANNEX_PULL_CRON_EXPRESSION, startChannexPullCron } from '../channexPullCron.js';

beforeEach(async () => {
  await testDb.deleteFrom('channex_config').execute();
  await testDb.deleteFrom('channex_pull_status').execute();
});

function fakeScheduler() {
  const registered: { expression: string; callback: () => void }[] = [];
  const schedule = (expression: string, callback: () => void) => {
    registered.push({ expression, callback });
    return { stop: vi.fn() };
  };
  return { schedule, registered };
}

describe('startChannexPullCron', () => {
  it('registers on the 15-20 minute expression Channex certification requires, not an arbitrary one', () => {
    const { schedule, registered } = fakeScheduler();

    startChannexPullCron(testDb, { schedule });

    expect(registered).toHaveLength(1);
    expect(registered[0].expression).toBe(CHANNEX_PULL_CRON_EXPRESSION);
    expect(CHANNEX_PULL_CRON_EXPRESSION).toBe('*/15 * * * *');
  });

  it('firing the registered callback actually runs a pull (no property configured -> skipped_not_configured)', async () => {
    const { schedule, registered } = fakeScheduler();
    const onRunComplete = vi.fn();

    startChannexPullCron(testDb, { schedule, onRunComplete });
    registered[0].callback();

    await vi.waitFor(() => expect(onRunComplete).toHaveBeenCalledTimes(1));
    expect(onRunComplete).toHaveBeenCalledWith({ kind: 'skipped_not_configured' });
  });

  it('a rejected run reaches onRunError instead of throwing out of the scheduled callback', async () => {
    const { schedule, registered } = fakeScheduler();
    const onRunError = vi.fn();
    const brokenDb = {
      selectFrom: () => {
        throw new Error('boom');
      },
    } as unknown as typeof testDb;

    startChannexPullCron(brokenDb, { schedule, onRunError });
    registered[0].callback();

    await vi.waitFor(() => expect(onRunError).toHaveBeenCalledTimes(1));
    expect((onRunError.mock.calls[0][0] as Error).message).toBe('boom');
  });
});
