/**
 * Global vitest setup (registered via `setupFiles` in vitest.config.ts,
 * applies to every test file). Drains SPEC-modulo-12C's fire-and-forget
 * Channex push after each test — see `channex/pushAvailability.ts`'s
 * `waitForPendingPushes` for the full incident this closes: dozens of
 * pre-existing test files exercise the 6 local operations that module now
 * hooks into, none of them aware of the new unawaited DB read that fires on
 * every one of those calls. Under `fileParallelism: false`, a stray query
 * left in flight when this file's tests finish can still be running when
 * the NEXT file's `beforeEach` TRUNCATEs the same tables — this hook
 * prevents that without changing the push's fire-and-forget semantics for
 * production callers (it's still never awaited by whatever operation
 * triggered it; only the TEST PROCESS waits, after the fact).
 */
import { afterEach } from 'vitest';

// Deliberately a LAZY dynamic import, not a static top-level one: setupFiles
// run before the test file's own `vi.mock(...)` calls are registered, so a
// static import here would load pushAvailability.js (and its real
// channexClient.js) before a test file's mock of channexClient.js ever
// applies — the module graph would already be cached with the real,
// unmocked dependency, and per-file mocks would silently never take effect.
// Importing inside the hook instead means the FIRST call happens only after
// the test file itself has already run (and registered its own mocks, if
// any), so this resolves to whatever module instance that file is using.
afterEach(async () => {
  const { waitForPendingPushes } = await import('../channex/pushAvailability.js');
  await waitForPendingPushes();
});
