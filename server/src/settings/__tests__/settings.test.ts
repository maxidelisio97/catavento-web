import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { getSetting, getBusinessSettings, MissingSettingError, InvalidSettingError } from '../settings.js';

const KEYS = ['deposit_percent', 'hold_minutes', 'pet_fee_cents'] as const;

// `settings` holds the real seeded business config other test files depend
// on (e.g. reservations.test.ts calls POST /api/reservations, which reads
// it). Don't TRUNCATE it — snapshot the seed rows once and restore them
// after every test instead, so this file can freely mutate/delete the keys
// under test without leaking state into other test files.
let seedRows: { key: string; value: string }[] = [];

beforeAll(async () => {
  seedRows = await testDb.selectFrom('settings').select(['key', 'value']).where('key', 'in', KEYS).execute();
});

async function clearKeys(): Promise<void> {
  await testDb.deleteFrom('settings').where('key', 'in', KEYS).execute();
}

afterEach(async () => {
  await clearKeys();
  if (seedRows.length > 0) {
    await testDb.insertInto('settings').values(seedRows).execute();
  }
});

describe('getSetting', () => {
  it('reads and type-coerces a known key', async () => {
    await clearKeys();
    await testDb.insertInto('settings').values({ key: 'deposit_percent', value: '50' }).execute();

    const value = await getSetting(testDb, 'deposit_percent');
    expect(value).toBe(50);
  });

  it('throws a clear error when the key is missing', async () => {
    await clearKeys();

    await expect(getSetting(testDb, 'hold_minutes')).rejects.toBeInstanceOf(MissingSettingError);
  });

  it('throws a clear error when the stored value does not match the expected shape', async () => {
    await clearKeys();
    await testDb.insertInto('settings').values({ key: 'hold_minutes', value: 'not-a-number' }).execute();

    await expect(getSetting(testDb, 'hold_minutes')).rejects.toBeInstanceOf(InvalidSettingError);
  });
});

describe('getBusinessSettings', () => {
  it('reads every business setting in one call', async () => {
    await clearKeys();
    await testDb
      .insertInto('settings')
      .values([
        { key: 'deposit_percent', value: '50' },
        { key: 'hold_minutes', value: '30' },
        { key: 'pet_fee_cents', value: '3000' },
      ])
      .execute();

    const settings = await getBusinessSettings(testDb);
    expect(settings).toEqual({ depositPercent: 50, holdMinutes: 30, petFeeCents: 3000 });
  });

  it('throws if any required key is missing', async () => {
    await clearKeys();
    await testDb
      .insertInto('settings')
      .values([
        { key: 'deposit_percent', value: '50' },
        { key: 'hold_minutes', value: '30' },
      ])
      .execute();

    await expect(getBusinessSettings(testDb)).rejects.toBeInstanceOf(MissingSettingError);
  });
});
