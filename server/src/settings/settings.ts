/**
 * Typed access to the `settings` table (business parameters as data, per
 * server/CLAUDE.md § "parámetros de negocio como datos"). Values are stored
 * as raw TEXT in Postgres; this module is the single place that knows how to
 * parse each key into a real type.
 */

import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import type { DB } from '../db/types.js';

// Exported so callers that write settings (e.g. panelSettings.ts) validate
// against the exact same per-key rules used to read them, instead of
// redefining the ranges in a second place.
export const settingsSchemas = {
  deposit_percent: z.coerce.number().int().min(0).max(100),
  // Floor of 15 (not the DB's bare "positive"): a hold shorter than that
  // doesn't leave enough time to complete an Asaas payment (business
  // decision, SPEC-modulo-8-configuracion.md § 4.2).
  hold_minutes: z.coerce.number().int().min(15),
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

export type SettingsPatch = Partial<{ [K in SettingKey]: number }>;

/**
 * Validates and writes a partial set of settings. Rows for all three keys
 * are guaranteed to exist (seeded by migration), so this is a plain UPDATE —
 * no upsert needed. No in-memory cache exists anywhere in this codebase
 * (getBusinessSettings reads the table directly), so there's nothing to
 * invalidate after this write.
 */
export async function updateSettings(executor: Kysely<DB> | Transaction<DB>, patch: SettingsPatch): Promise<void> {
  const entries = Object.entries(patch) as [SettingKey, number][];

  for (const [key, rawValue] of entries) {
    const parsed = settingsSchemas[key].safeParse(rawValue);
    if (!parsed.success) {
      throw new InvalidSettingError(key, String(rawValue));
    }

    await executor.updateTable('settings').set({ value: String(parsed.data) }).where('key', '=', key).execute();
  }
}
