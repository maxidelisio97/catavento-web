/**
 * GET/POST /panel/roles, PATCH/DELETE /panel/roles/:id —
 * SPEC-modulo-9-usuarios-permisos.md § 4.5.
 */
import type { FastifyError, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { requireAuth } from '../auth/requireAuth.js';
import { blockIfMustChangePassword } from '../auth/blockIfMustChangePassword.js';
import { requirePermission } from '../auth/requirePermission.js';

const roleResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  is_system: z.boolean(),
  is_owner: z.boolean(),
  permissions: z.array(z.string()),
});

const errorResponseSchema = z.object({ error: z.string() });

// is_owner is deliberately NOT a settable field anywhere in this schema —
// the only is_owner=true role is the one seeded by the migration (§ 2.4:
// "no editable... no borrable"). This is what stops a second Dueño-equivalent
// role from ever being created or an existing one from losing the flag.
const createRoleBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string()).default([]),
});

const patchRoleBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().max(500).nullable().optional(),
    permissions: z.array(z.string()).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Body must include at least one field' });

function httpError(statusCode: number, message: string): FastifyError {
  const err = new Error(message) as FastifyError;
  err.statusCode = statusCode;
  err.code = 'PANEL_ROLES_ERROR';
  err.name = 'PanelRolesError';
  return err;
}

async function loadRoleWithPermissions(db: Kysely<DB>, roleId: number) {
  const role = await db
    .selectFrom('roles')
    .select(['id', 'name', 'description', 'is_system', 'is_owner'])
    .where('id', '=', roleId)
    .executeTakeFirst();
  if (!role) return null;

  const permissionRows = await db
    .selectFrom('role_permissions')
    .select('permission')
    .where('role_id', '=', roleId)
    .execute();

  return { ...role, permissions: permissionRows.map((row) => row.permission) };
}

export interface PanelRolesPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const panelRolesPlugin: FastifyPluginAsync<PanelRolesPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  await fastify.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', requireAuth(db));
    protectedScope.addHook('onRequest', blockIfMustChangePassword());
    protectedScope.addHook('onRequest', requirePermission(db, 'admin.roles'));
    const typed = protectedScope.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/panel/roles',
      { schema: { response: { 200: z.array(roleResponseSchema) } } },
      async () => {
        const roles = await db.selectFrom('roles').select(['id', 'name', 'description', 'is_system', 'is_owner']).orderBy('id').execute();
        const permissionRows = await db.selectFrom('role_permissions').select(['role_id', 'permission']).execute();

        return roles.map((role) => ({
          ...role,
          permissions: permissionRows.filter((row) => row.role_id === role.id).map((row) => row.permission),
        }));
      },
    );

    typed.post(
      '/panel/roles',
      {
        schema: {
          body: createRoleBodySchema,
          response: { 201: roleResponseSchema, 409: errorResponseSchema },
        },
      },
      async (request, reply) => {
        const { name, description, permissions } = request.body;

        try {
          const roleId = await db.transaction().execute(async (trx) => {
            const role = await trx
              .insertInto('roles')
              .values({ name, description: description ?? null })
              .returning('id')
              .executeTakeFirstOrThrow();

            if (permissions.length > 0) {
              await trx
                .insertInto('role_permissions')
                .values(permissions.map((permission) => ({ role_id: role.id, permission })))
                .execute();
            }

            return role.id;
          });

          reply.status(201);
          // Guaranteed non-null: the transaction above just created this role.
          return (await loadRoleWithPermissions(db, roleId))!;
        } catch (err) {
          if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
            throw httpError(409, 'ROLE_NAME_ALREADY_EXISTS');
          }
          throw err;
        }
      },
    );

    typed.patch(
      '/panel/roles/:id',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          body: patchRoleBodySchema,
          response: { 200: roleResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
        },
      },
      async (request) => {
        const { id } = request.params;
        const { permissions, ...rest } = request.body;

        const role = await db.selectFrom('roles').select(['id', 'is_owner']).where('id', '=', id).executeTakeFirst();
        if (!role) throw httpError(404, 'ROLE_NOT_FOUND');
        // § 2.2/§ 2.4: the Dueño role's own definition is not editable —
        // "no editable en sus permisos" (it has every permission by nature,
        // not by this table's contents).
        if (role.is_owner) throw httpError(409, 'OWNER_ROLE_NOT_EDITABLE');

        await db.transaction().execute(async (trx) => {
          if (Object.keys(rest).length > 0) {
            await trx.updateTable('roles').set(rest).where('id', '=', id).execute();
          }
          if (permissions) {
            await trx.deleteFrom('role_permissions').where('role_id', '=', id).execute();
            if (permissions.length > 0) {
              await trx
                .insertInto('role_permissions')
                .values(permissions.map((permission) => ({ role_id: id, permission })))
                .execute();
            }
          }
        });

        // Guaranteed non-null: already confirmed to exist above.
        return (await loadRoleWithPermissions(db, id))!;
      },
    );

    typed.delete(
      '/panel/roles/:id',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          response: { 204: z.void(), 404: errorResponseSchema, 409: errorResponseSchema },
        },
      },
      async (request, reply) => {
        const { id } = request.params;

        const role = await db.selectFrom('roles').select(['id', 'is_system']).where('id', '=', id).executeTakeFirst();
        if (!role) throw httpError(404, 'ROLE_NOT_FOUND');
        if (role.is_system) throw httpError(409, 'SYSTEM_ROLE_NOT_DELETABLE');

        const assignedUser = await db.selectFrom('users').select('id').where('role_id', '=', id).executeTakeFirst();
        if (assignedUser) throw httpError(409, 'ROLE_HAS_ASSIGNED_USERS');

        await db.deleteFrom('roles').where('id', '=', id).execute();
        reply.status(204).send();
      },
    );
  });
};

export default panelRolesPlugin;
