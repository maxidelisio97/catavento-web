import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { requireAuth } from '../auth/requireAuth.js';
import { blockIfMustChangePassword } from '../auth/blockIfMustChangePassword.js';
import { requirePermission } from '../auth/requirePermission.js';
import { getBusinessSettings, settingsSchemas, updateSettings } from '../settings/settings.js';

const settingsResponseSchema = z.object({
  deposit_percent: z.number(),
  hold_minutes: z.number(),
  pet_fee_cents: z.number(),
});

// Reuses the exact per-key schemas settings.ts already defines (per
// SPEC-modulo-8-configuracion.md § 4.2 — "no redefinir") so this endpoint
// can't drift from the validation the rest of the codebase relies on.
const settingsPatchSchema = z.object(settingsSchemas).partial();

export interface PanelSettingsPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const panelSettingsPlugin: FastifyPluginAsync<PanelSettingsPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  await fastify.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', requireAuth(db));
    protectedScope.addHook('onRequest', blockIfMustChangePassword());
    protectedScope.addHook('onRequest', requirePermission(db, 'config.settings'));
    const typed = protectedScope.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/panel/settings',
      { schema: { response: { 200: settingsResponseSchema } } },
      async () => {
        const settings = await getBusinessSettings(db);
        return {
          deposit_percent: settings.depositPercent,
          hold_minutes: settings.holdMinutes,
          pet_fee_cents: settings.petFeeCents,
        };
      },
    );

    typed.patch(
      '/panel/settings',
      {
        schema: {
          body: settingsPatchSchema,
          response: { 200: settingsResponseSchema },
        },
      },
      async (request) => {
        await updateSettings(db, request.body);

        const settings = await getBusinessSettings(db);
        return {
          deposit_percent: settings.depositPercent,
          hold_minutes: settings.holdMinutes,
          pet_fee_cents: settings.petFeeCents,
        };
      },
    );
  });
};

export default panelSettingsPlugin;
