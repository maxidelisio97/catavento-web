const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;

interface AttemptWindow {
  count: number;
  windowStartedAt: number;
}

// In-memory, keyed by "email|ip" — SPEC-modulo-6-panel-base.md § "6B.3
// Endpoints de auth": max 5 failed attempts per email+IP per 15 minutes.
//
// This is correct ONLY because ecosystem.config.cjs runs this app as a
// single PM2 fork-mode process (no `instances` / `exec_mode: 'cluster'`),
// so every request lands on the same Node process and this Map is a true
// global counter. If this is ever scaled to PM2 cluster mode or multiple
// instances behind a load balancer, this silently degrades to "N failed
// attempts allowed PER PROCESS" with no error or warning — move the
// counter to a shared store (a table, Redis) before doing that.
const attempts = new Map<string, AttemptWindow>();

function key(email: string, ip: string): string {
  return `${email.toLowerCase()}|${ip}`;
}

function isExpired(entry: AttemptWindow): boolean {
  return Date.now() - entry.windowStartedAt > WINDOW_MS;
}

export function isRateLimited(email: string, ip: string): boolean {
  const entry = attempts.get(key(email, ip));
  if (!entry || isExpired(entry)) return false;
  return entry.count >= MAX_FAILED_ATTEMPTS;
}

export function recordFailedAttempt(email: string, ip: string): void {
  const k = key(email, ip);
  const entry = attempts.get(k);

  if (!entry || isExpired(entry)) {
    attempts.set(k, { count: 1, windowStartedAt: Date.now() });
    return;
  }

  entry.count += 1;
}

// A successful login resets the counter — SPEC: "Los intentos exitosos
// resetean el contador."
export function clearAttempts(email: string, ip: string): void {
  attempts.delete(key(email, ip));
}

// Test-only: this Map is process-global by design (see comment above), so
// without this, one test's failed-login-lockout case would bleed into every
// other test that runs afterwards in the same vitest process.
export function resetRateLimiterForTests(): void {
  attempts.clear();
}
