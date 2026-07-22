import argon2 from 'argon2';

// SPEC-modulo-6-panel-base.md § "6B.1 Modelo de usuarios": argon2id
// explicitly, not argon2's library default (which already happens to be
// argon2id, but pinning it here means a future argon2 major version
// changing its default can never silently downgrade this).
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // Malformed/foreign hash format — never let this bubble up as a 500 and
    // never treat it as a match.
    return false;
  }
}
