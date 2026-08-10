import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * SPEC-modulo-9-usuarios-permisos.md § 4.5 — a temporary password set by an
 * admin (POST /panel/users) must not be usable indefinitely. Registered
 * AFTER requireAuth in every protected scope EXCEPT auth.ts's own protected
 * scope, so a user stuck in this state can still call POST
 * /panel/auth/change-password, POST /panel/auth/logout(-all), and GET
 * /panel/auth/me — everything else 403s until they change their password.
 *
 * Unlike requireAuth's bare 401 and requirePermission's bare 403, this
 * reply carries a body: MUST_CHANGE_PASSWORD is an expected state a
 * legitimate, already-identified user needs to resolve (9C's frontend
 * redirects to a change-password screen on seeing it), not information
 * worth hiding from them.
 */
export function blockIfMustChangePassword() {
  return async function onRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (request.user!.mustChangePassword) {
      reply.status(403).send({ error: 'MUST_CHANGE_PASSWORD' });
    }
  };
}
