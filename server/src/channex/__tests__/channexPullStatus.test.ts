import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { getChannexPullStatus, recordPullFailure, recordPullSuccess } from '../channexPullStatus.js';

beforeEach(async () => {
  await testDb.deleteFrom('channex_pull_status').execute();
});

describe('channexPullStatus', () => {
  it('starts with nothing recorded', async () => {
    const status = await getChannexPullStatus(testDb);
    expect(status).toEqual({ lastRunAt: null, lastSuccessAt: null, lastError: null });
  });

  it('records a successful run: both last_run_at and last_success_at move, last_error clears', async () => {
    await recordPullSuccess(testDb);

    const status = await getChannexPullStatus(testDb);
    expect(status.lastRunAt).toBeInstanceOf(Date);
    expect(status.lastSuccessAt).toBeInstanceOf(Date);
    expect(status.lastError).toBeNull();
  });

  it('a failed run must NOT look like a successful one: last_success_at stays untouched, last_error is set', async () => {
    await recordPullFailure(testDb, 'Channex respondeu 500');

    const status = await getChannexPullStatus(testDb);
    expect(status.lastRunAt).toBeInstanceOf(Date);
    expect(status.lastSuccessAt).toBeNull();
    expect(status.lastError).toBe('Channex respondeu 500');
  });

  it('a failure after a prior success keeps the old last_success_at, not null and not the new failed attempt time', async () => {
    await recordPullSuccess(testDb);
    const afterSuccess = await getChannexPullStatus(testDb);

    await recordPullFailure(testDb, 'timeout');
    const afterFailure = await getChannexPullStatus(testDb);

    expect(afterFailure.lastSuccessAt).toEqual(afterSuccess.lastSuccessAt);
    expect(afterFailure.lastError).toBe('timeout');
    expect(afterFailure.lastRunAt!.getTime()).toBeGreaterThanOrEqual(afterSuccess.lastRunAt!.getTime());
  });

  it('a success after a prior failure clears the old error', async () => {
    await recordPullFailure(testDb, 'timeout');
    await recordPullSuccess(testDb);

    const status = await getChannexPullStatus(testDb);
    expect(status.lastError).toBeNull();
    expect(status.lastSuccessAt).toBeInstanceOf(Date);
  });
});
