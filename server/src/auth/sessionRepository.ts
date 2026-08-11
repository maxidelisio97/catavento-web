import { randomBytes, createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';

const SESSION_DURATION_DAYS = 30;
// SPEC §6B.2: "en cada request autenticado, si expires_at está a menos de
// 25 días de distancia ... se empuja expires_at a now() + 30 días". Renewing
// only under this threshold (instead of every request) is what avoids an
// UPDATE per request.
const RENEWAL_THRESHOLD_DAYS = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface CreateSessionInput {
  userId: number;
  userAgent?: string | null;
  ip?: string | null;
}

export interface CreateSessionResult {
  token: string;
  expiresAt: Date;
}

export async function createSession(
  db: Kysely<DB>,
  input: CreateSessionInput,
): Promise<CreateSessionResult> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_DAYS * DAY_MS);

  await db
    .insertInto('sessions')
    .values({
      user_id: input.userId,
      token_hash: hashToken(token),
      expires_at: expiresAt,
      user_agent: input.userAgent ?? null,
      ip: input.ip ?? null,
    })
    .execute();

  return { token, expiresAt };
}

export interface SessionWithUser {
  sessionId: string;
  userId: number;
  email: string;
  name: string;
  role: string;
  mustChangePassword: boolean;
}

/**
 * SPEC §6B.2: "Sesión inválida si: no existe, revoked_at no nulo,
 * expires_at < now(), o el usuario está inactivo." This is the single
 * predicate every /panel/* request goes through (via requireAuth) — same
 * "one source of truth" shape as availability/isReservationActive.ts.
 *
 * Also performs the sliding renewal described above when the session
 * qualifies, so callers never have to remember to do it separately.
 */
export async function findValidSession(
  db: Kysely<DB>,
  token: string,
): Promise<SessionWithUser | null> {
  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      'sessions.id as session_id',
      'sessions.expires_at',
      'sessions.revoked_at',
      'users.id as user_id',
      'users.email',
      'users.name',
      'users.role',
      'users.is_active',
      'users.must_change_password',
    ])
    .where('sessions.token_hash', '=', hashToken(token))
    .executeTakeFirst();

  if (!row) return null;
  if (row.revoked_at != null) return null;
  if (new Date(row.expires_at) <= new Date()) return null;
  if (!row.is_active) return null;

  const remainingDays = (new Date(row.expires_at).getTime() - Date.now()) / DAY_MS;

  if (remainingDays < RENEWAL_THRESHOLD_DAYS) {
    const renewedExpiresAt = new Date(Date.now() + SESSION_DURATION_DAYS * DAY_MS);
    await db
      .updateTable('sessions')
      .set({ expires_at: renewedExpiresAt, last_used_at: new Date() })
      .where('id', '=', row.session_id)
      .execute();
  }

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    mustChangePassword: row.must_change_password,
  };
}

export async function revokeSession(db: Kysely<DB>, sessionId: string): Promise<void> {
  await db
    .updateTable('sessions')
    .set({ revoked_at: new Date() })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .execute();
}

// SPEC §6B.3 "logout-all": revokes every live session of the user,
// including the one making the request.
export async function revokeAllSessionsForUser(db: Kysely<DB>, userId: number): Promise<void> {
  await db
    .updateTable('sessions')
    .set({ revoked_at: new Date() })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
}
