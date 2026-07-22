import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { config } from '../config.js';
import { verifyPassword } from '../auth/hashPassword.js';
import { createSession, revokeSession, revokeAllSessionsForUser } from '../auth/sessionRepository.js';
import { requireAuth } from '../auth/requireAuth.js';
import { isRateLimited, recordFailedAttempt, clearAttempts } from '../auth/loginRateLimiter.js';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../auth/cookie.js';

// SPEC §6B.3: "Error genérico 'credenciales inválidas' (nunca distinguir
// email inexistente de contraseña incorrecta)." Copy in Portuguese — the
// panel, like the rest of the system, is PT-only (SPEC § 7).
const GENERIC_LOGIN_ERROR = 'Credenciais inválidas';

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const userResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string(),
  role: z.string(),
});

const errorResponseSchema = z.object({ error: z.string() });

interface AuthPluginOptions {
  db?: Kysely<DB>;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;
  const typed = fastify.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/panel/auth/login',
    {
      schema: {
        body: loginBodySchema,
        response: {
          200: z.object({ user: userResponseSchema }),
          401: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const ip = request.ip;

      if (isRateLimited(email, ip)) {
        reply.status(429).send({ error: 'too_many_attempts' });
        return;
      }

      const user = await db
        .selectFrom('users')
        .select(['id', 'email', 'name', 'role', 'password_hash', 'is_active'])
        .where('email', '=', email)
        .executeTakeFirst();

      // Always run verifyPassword against SOME hash, even when the user
      // doesn't exist, so a nonexistent-email request and a wrong-password
      // request take roughly the same amount of time — otherwise a fast
      // 401 on unknown emails would leak which emails have accounts, which
      // is exactly the distinction the generic error message is meant to
      // hide.
      const passwordOk = await verifyPassword(
        user?.password_hash ?? DUMMY_HASH,
        password,
      );

      if (!user || !user.is_active || !passwordOk) {
        recordFailedAttempt(email, ip);
        fastify.log.warn({ email, ip, event: 'panel_login_failed' });
        reply.status(401).send({ error: GENERIC_LOGIN_ERROR });
        return;
      }

      clearAttempts(email, ip);

      const { token } = await createSession(db, {
        userId: user.id,
        userAgent: request.headers['user-agent'] ?? null,
        ip,
      });

      reply.setCookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
      fastify.log.info({ email, ip, event: 'panel_login_success' });

      return { user: { id: user.id, name: user.name, email: user.email, role: user.role } };
    },
  );

  await fastify.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', requireAuth(db));
    const typedProtected = protectedScope.withTypeProvider<ZodTypeProvider>();

    typedProtected.post('/panel/auth/logout', async (request, reply) => {
      await revokeSession(db, request.user!.sessionId);
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/', domain: config.panelCookieDomain });
      reply.status(204).send();
    });

    typedProtected.post('/panel/auth/logout-all', async (request, reply) => {
      await revokeAllSessionsForUser(db, request.user!.id);
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/', domain: config.panelCookieDomain });
      fastify.log.info({ userId: request.user!.id, event: 'panel_logout_all' });
      reply.status(204).send();
    });

    typedProtected.get(
      '/panel/auth/me',
      { schema: { response: { 200: z.object({ user: userResponseSchema }) } } },
      async (request) => {
        const { id, name, email, role } = request.user!;
        return { user: { id, name, email, role } };
      },
    );
  });
};

// A real argon2id hash of a random, never-used string — spent once at
// module load, not per request, purely so verifyPassword() always has a
// hash to compare against on a login attempt for a nonexistent email (see
// the timing-safety comment above).
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$lzgjxT8VB4RVFCVzwP1b2A$V/ZOy8kn9/7NBHIYI0jErdedd2SR5h7sotfluwDX6D8';

export default authPlugin;
