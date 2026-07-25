/**
 * Typed access to the `settings` table (business parameters as data, per
 * server/CLAUDE.md § "parámetros de negocio como datos"). Values are stored
 * as raw TEXT in Postgres; this module is the single place that knows how to
 * parse each key into a real type.
 */

import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import type { DB } from '../db/types.js';

const settingsSchemas = {
  deposit_percent: z.coerce.number().int().min(0).max(100),
  hold_minutes: z.coerce.number().int().min(1),
  pet_fee_cents: z.coerce.number().int().min(0),
} as const;

export type SettingKey = keyof typeof settingsSchemas;

export class MissingSettingError extends Error {
  constructor(readonly key: string) {
    super(`Missing required setting: "${key}" (row not found in settings table)`);
  }
}

export class InvalidSettingError extends Error {
  constructor(
    readonly key: string,
    readonly rawValue: string,
  ) {
    super(`Setting "${key}" has an invalid value: "${rawValue}"`);
  }
}

/** Reads and type-checks a single setting. Throws a clear error if it's missing or malformed. */
export async function getSetting<K extends SettingKey>(
  executor: Kysely<DB> | Transaction<DB>,
  key: K,
): Promise<z.infer<(typeof settingsSchemas)[K]>> {
  const row = await executor.selectFrom('settings').select('value').where('key', '=', key).executeTakeFirst();

  if (!row) {
    throw new MissingSettingError(key);
  }

  const schema = settingsSchemas[key];
  const parsed = schema.safeParse(row.value);
  if (!parsed.success) {
    throw new InvalidSettingError(key, row.value);
  }

  return parsed.data;
}

export interface BusinessSettings {
  depositPercent: number;
  holdMinutes: number;
  petFeeCents: number;
}

/** Reads every setting the reservation flow depends on, in one round trip. */
export async function getBusinessSettings(executor: Kysely<DB> | Transaction<DB>): Promise<BusinessSettings> {
  const rows = await executor
    .selectFrom('settings')
    .select(['key', 'value'])
    .where('key', 'in', ['deposit_percent', 'hold_minutes', 'pet_fee_cents'])
    .execute();

  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  const parse = <K extends SettingKey>(key: K): z.infer<(typeof settingsSchemas)[K]> => {
    const rawValue = byKey.get(key);
    if (rawValue === undefined) {
      throw new MissingSettingError(key);
    }
    const parsed = settingsSchemas[key].safeParse(rawValue);
    if (!parsed.success) {
      throw new InvalidSettingError(key, rawValue);
    }
    return parsed.data;
  };

  return {
    depositPercent: parse('deposit_percent'),
    holdMinutes: parse('hold_minutes'),
    petFeeCents: parse('pet_fee_cents'),
  };
}
