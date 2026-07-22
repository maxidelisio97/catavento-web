import type { CookieSerializeOptions } from '@fastify/cookie';
import { config } from '../config.js';

export const SESSION_COOKIE_NAME = 'catavento_session';

const SESSION_DURATION_SECONDS = 30 * 24 * 60 * 60;

export function sessionCookieOptions(): CookieSerializeOptions {
  return {
    httpOnly: true,
    // SPEC §6B.2 requires Secure: true unconditionally. In local dev the
    // panel and API run over plain HTTP, and browsers silently drop a
    // Secure cookie set over HTTP — so this is true only when
    // NODE_ENV=production. Never relax this in production: it's the only
    // thing stopping the session token from being replayable by anyone on
    // the same network as an HTTP request.
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    domain: config.panelCookieDomain,
    maxAge: SESSION_DURATION_SECONDS,
  };
}
