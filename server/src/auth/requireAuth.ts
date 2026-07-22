import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { findValidSession } from './sessionRepository.js';
import { SESSION_COOKIE_NAME } from './cookie.js';

export interface AuthenticatedUser {
  id: number;
  email: string;
  name: string;
  role: string;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

/**
 * SPEC-modulo-6-panel-base.md § "6B.3 Endpoints de auth": "Middleware
 * requireAuth: aplicado a todo /panel/* excepto login." This is that
 * middleware, as a hook factory rather than a globally-registered plugin —
 * any plugin that adds protected /panel/* routes (6B's logout/logout-all/me
 * today, 6C's tape-chart/reservations later) must call
 * `scope.addHook('onRequest', requireAuth(db))` inside its OWN encapsulated
 * Fastify scope. Registering it globally on the app would 401 the login
 * route itself, since Fastify hooks apply to the whole app unless scoped.
 *
 * Replies bare 401 (no body) on failure, per spec — never leaks whether the
 * cookie was missing, expired, revoked, or the user was deactivated.
 */
export function requireAuth(db: Kysely<DB>) {
  return async function onRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies[SESSION_COOKIE_NAME];
    const session = token ? await findValidSession(db, token) : null;

    if (!session) {
      reply.status(401).send();
      return;
    }

    request.user = {
      id: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
      sessionId: session.sessionId,
    };
  };
}
