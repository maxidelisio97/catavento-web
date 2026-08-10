/**
 * GET /panel/permissions, GET /panel/me/permissions —
 * SPEC-modulo-9-usuarios-permisos.md § 4.5.
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
import { effectivePermissions } from '../permissions/effectivePermissions.js';
import { getAllPermissionKeys, getEffectivePermissionInput } from '../permissions/permissionRepository.js';

const permissionResponseSchema = z.object({ key: z.string(), description: z.string() });

export interface PanelPermissionsPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const panelPermissionsPlugin: FastifyPluginAsync<PanelPermissionsPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  await fastify.register(async (catalogScope) => {
    catalogScope.addHook('onRequest', requireAuth(db));
    catalogScope.addHook('onRequest', blockIfMustChangePassword());
    catalogScope.addHook('onRequest', requirePermission(db, 'admin.users'));
    const typed = catalogScope.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/panel/permissions',
      { schema: { response: { 200: z.array(permissionResponseSchema) } } },
      async () => {
        return db.selectFrom('permissions').select(['key', 'description']).orderBy('key').execute();
      },
    );
  });

  // Deliberately its own scope with only requireAuth, no
  // blockIfMustChangePassword/requirePermission (§ 4.5): any logged-in user
  // — including one mid must-change-password — can ask what they can do.
  await fastify.register(async (meScope) => {
    meScope.addHook('onRequest', requireAuth(db));
    const typed = meScope.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/panel/me/permissions',
      { schema: { response: { 200: z.object({ permissions: z.array(z.string()) }) } } },
      async (request) => {
        const [input, allKeys] = await Promise.all([
          getEffectivePermissionInput(db, request.user!.id),
          getAllPermissionKeys(db),
        ]);

        return { permissions: [...effectivePermissions(input, allKeys)].sort() };
      },
    );
  });
};

export default panelPermissionsPlugin;
