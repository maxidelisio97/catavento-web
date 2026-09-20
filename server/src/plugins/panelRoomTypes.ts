/**
 * GET /panel/room-types — lightweight, read-only listing of active room
 * types (id + name only, no pricing). Exists so the panel's "Nova reserva"
 * form can populate a room-type dropdown without requiring the
 * `config.settings` permission that `GET /panel/room-rates` needs (that
 * endpoint exposes pricing, which a front-desk role creating manual
 * reservations has no reason to see). Gated by `reservations.create_manual`,
 * same permission as the rest of this feature.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { requireAuth } from '../auth/requireAuth.js';
import { blockIfMustChangePassword } from '../auth/blockIfMustChangePassword.js';
import { requirePermission } from '../auth/requirePermission.js';

const roomTypesResponseSchema = z.object({
  rooms: z.array(z.object({ id: z.number(), name: z.string() })),
});

export interface PanelRoomTypesPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const panelRoomTypesPlugin: FastifyPluginAsync<PanelRoomTypesPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  await fastify.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', requireAuth(db));
    protectedScope.addHook('onRequest', blockIfMustChangePassword());
    protectedScope.addHook('onRequest', requirePermission(db, 'reservations.create_manual'));
    const typed = protectedScope.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/panel/room-types',
      { schema: { response: { 200: roomTypesResponseSchema } } },
      async () => {
        const rooms = await db
          .selectFrom('rooms')
          .select(['id', 'name'])
          .where('active', '=', true)
          .orderBy('name')
          .execute();

        return { rooms };
      },
    );
  });
};

export default panelRoomTypesPlugin;
