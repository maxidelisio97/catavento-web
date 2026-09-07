import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { config } from '../config.js';

export interface ChannexConfigRecord {
  environment: 'staging' | 'production';
  propertyId: string | null;
  isActive: boolean;
}

export interface ChannexConfigPatch {
  propertyId?: string | null;
  isActive?: boolean;
}

/**
 * `environment` is never a writable field here (SPEC-modulo-12A § 3/§ 4 lists
 * it as a PATCH-able column, but that would let the stored value drift from
 * `config.channex.env` — the actual env var picking which base URL and which
 * CHANNEX_API_KEY get used). Deviation flagged to Maxi when entrega 1 landed:
 * this column always mirrors config.channex.env and is only ever read, never
 * set independently, so a panel operator can never point the UI at
 * "production" while the server is still authenticating against staging.
 */
export async function getChannexConfig(db: Kysely<DB>): Promise<ChannexConfigRecord> {
  const row = await db.selectFrom('channex_config').selectAll().where('id', '=', 1).executeTakeFirst();

  return {
    environment: config.channex.env,
    propertyId: row?.property_id ?? null,
    isActive: row?.is_active ?? false,
  };
}

export async function updateChannexConfig(db: Kysely<DB>, patch: ChannexConfigPatch): Promise<ChannexConfigRecord> {
  const current = await getChannexConfig(db);
  const propertyId = patch.propertyId !== undefined ? patch.propertyId : current.propertyId;
  const isActive = patch.isActive !== undefined ? patch.isActive : current.isActive;

  await db
    .insertInto('channex_config')
    .values({ id: 1, environment: config.channex.env, property_id: propertyId, is_active: isActive })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        environment: config.channex.env,
        property_id: propertyId,
        is_active: isActive,
      }),
    )
    .execute();

  return getChannexConfig(db);
}
