import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { can } from '../permissions/effectivePermissions.js';
import { getEffectivePermissionInput } from '../permissions/permissionRepository.js';

/**
 * SPEC-modulo-9-usuarios-permisos.md § 4.3. Same hook-factory shape as
 * requireAuth (../auth/requireAuth.ts) — scoped per-plugin via
 * `scope.addHook('onRequest', requirePermission(db, 'reservations.view'))`,
 * always registered AFTER requireAuth in the same protected scope so
 * `request.user` is already populated.
 *
 * Replies bare 403 (no body) on failure — same reasoning as requireAuth's
 * bare 401: never leak which specific permission was missing.
 */
export function requirePermission(db: Kysely<DB>, permission: string) {
  return async function onRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const input = await getEffectivePermissionInput(db, request.user!.id);

    if (!can(input, permission)) {
      reply.status(403).send();
    }
  };
}

/**
 * Same as requirePermission, but grants access if the user has ANY of the
 * given permissions (SPEC-modulo-9-usuarios-permisos.md § 4.5 — GET
 * /panel/permissions is readable by admin.users OR admin.roles).
 */
export function requireAnyPermission(db: Kysely<DB>, permissions: readonly string[]) {
  return async function onRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const input = await getEffectivePermissionInput(db, request.user!.id);

    if (!permissions.some((permission) => can(input, permission))) {
      reply.status(403).send();
    }
  };
}
