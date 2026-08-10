/**
 * GET/POST /panel/users, PATCH /panel/users/:id, PATCH /panel/users/:id/overrides,
 * POST /panel/users/:id/deactivate — SPEC-modulo-9-usuarios-permisos.md § 4.5.
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
import { hashPassword } from '../auth/hashPassword.js';
import { assertNotLastOwnerLockout, isOwnerRole, LastOwnerLockoutError } from '../permissions/ownerGuard.js';

const userResponseSchema = z.object({
  id: z.number(),
  email: z.string(),
  name: z.string(),
  role_id: z.number().nullable(),
  is_active: z.boolean(),
  must_change_password: z.boolean(),
});

const errorResponseSchema = z.object({ error: z.string() });

// § 4.5: "el admin la setea" — no email infra exists in this repo (verified
// before implementing) for a "communicated separately" flow, so the admin
// sets the temporary password directly. must_change_password=true always on
// creation, forcing it to be swapped on the employee's first login
// (blockIfMustChangePassword + POST /panel/auth/change-password).
const createUserBodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
  role_id: z.number().int().positive().nullable().optional(),
});

const patchUserBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    role_id: z.number().int().positive().nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Body must include at least one field' });

const overrideEntrySchema = z.object({
  permission: z.string(),
  // true = grant, false = revoke, null = remove the override (revert to role).
  granted: z.boolean().nullable(),
});

const overridesBodySchema = z.object({ overrides: z.array(overrideEntrySchema).min(1) });

function httpError(statusCode: number, message: string): FastifyError {
  const err = new Error(message) as FastifyError;
  err.statusCode = statusCode;
  err.code = 'PANEL_USERS_ERROR';
  err.name = 'PanelUsersError';
  return err;
}

export interface PanelUsersPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const panelUsersPlugin: FastifyPluginAsync<PanelUsersPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  await fastify.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', requireAuth(db));
    protectedScope.addHook('onRequest', blockIfMustChangePassword());
    protectedScope.addHook('onRequest', requirePermission(db, 'admin.users'));
    const typed = protectedScope.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/panel/users',
      { schema: { response: { 200: z.array(userResponseSchema) } } },
      async () => {
        return db
          .selectFrom('users')
          .select(['id', 'email', 'name', 'role_id', 'is_active', 'must_change_password'])
          .orderBy('id')
          .execute();
      },
    );

    typed.post(
      '/panel/users',
      {
        schema: {
          body: createUserBodySchema,
          response: { 201: userResponseSchema, 409: errorResponseSchema },
        },
      },
      async (request, reply) => {
        const { email, name, password, role_id } = request.body;
        const passwordHash = await hashPassword(password);

        try {
          const user = await db
            .insertInto('users')
            .values({
              email,
              name,
              password_hash: passwordHash,
              role_id: role_id ?? null,
              must_change_password: true,
            })
            .returning(['id', 'email', 'name', 'role_id', 'is_active', 'must_change_password'])
            .executeTakeFirstOrThrow();

          reply.status(201);
          return user;
        } catch (err) {
          // citext unique violation on email — Postgres error code 23505.
          if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
            throw httpError(409, 'EMAIL_ALREADY_EXISTS');
          }
          throw err;
        }
      },
    );

    typed.patch(
      '/panel/users/:id',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          body: patchUserBodySchema,
          response: { 200: userResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
        },
      },
      async (request) => {
        const { id } = request.params;
        const patch = request.body;

        try {
          return await db.transaction().execute(async (trx) => {
            const target = await trx
              .selectFrom('users')
              .select(['id', 'role_id', 'is_active'])
              .where('id', '=', id)
              .executeTakeFirst();
            if (!target) throw httpError(404, 'USER_NOT_FOUND');

            const nextRoleId = 'role_id' in patch ? (patch.role_id ?? null) : target.role_id;
            const nextIsActive = patch.is_active ?? target.is_active;
            const willRemainActiveOwner = nextIsActive && (await isOwnerRole(trx, nextRoleId));

            await assertNotLastOwnerLockout(trx, id, willRemainActiveOwner);

            return await trx
              .updateTable('users')
              .set(patch)
              .where('id', '=', id)
              .returning(['id', 'email', 'name', 'role_id', 'is_active', 'must_change_password'])
              .executeTakeFirstOrThrow();
          });
        } catch (err) {
          if (err instanceof LastOwnerLockoutError) throw httpError(409, 'LAST_OWNER_LOCKOUT');
          throw err;
        }
      },
    );

    typed.patch(
      '/panel/users/:id/overrides',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          body: overridesBodySchema,
          response: { 204: z.void(), 404: errorResponseSchema },
        },
      },
      async (request, reply) => {
        const { id } = request.params;

        const user = await db.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst();
        if (!user) throw httpError(404, 'USER_NOT_FOUND');

        await db.transaction().execute(async (trx) => {
          for (const { permission, granted } of request.body.overrides) {
            if (granted === null) {
              await trx
                .deleteFrom('user_permission_overrides')
                .where('user_id', '=', id)
                .where('permission', '=', permission)
                .execute();
            } else {
              await trx
                .insertInto('user_permission_overrides')
                .values({ user_id: id, permission, granted })
                .onConflict((oc) => oc.columns(['user_id', 'permission']).doUpdateSet({ granted }))
                .execute();
            }
          }
        });

        reply.status(204).send();
      },
    );

    // § 2.4: deactivating the last active Dueño is the same lockout risk as
    // demoting them — same guard, different trigger.
    typed.post(
      '/panel/users/:id/deactivate',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          response: { 200: userResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
        },
      },
      async (request) => {
        const { id } = request.params;

        try {
          return await db.transaction().execute(async (trx) => {
            const target = await trx.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst();
            if (!target) throw httpError(404, 'USER_NOT_FOUND');

            await assertNotLastOwnerLockout(trx, id, false);

            return await trx
              .updateTable('users')
              .set({ is_active: false })
              .where('id', '=', id)
              .returning(['id', 'email', 'name', 'role_id', 'is_active', 'must_change_password'])
              .executeTakeFirstOrThrow();
          });
        } catch (err) {
          if (err instanceof LastOwnerLockoutError) throw httpError(409, 'LAST_OWNER_LOCKOUT');
          throw err;
        }
      },
    );
  });
};

export default panelUsersPlugin;
