import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several test files share catavento_db_test and TRUNCATE the same
    // tables between cases. Running files in parallel (Vitest's default)
    // causes real FK violations and deadlocks between them — force
    // sequential file execution instead.
    fileParallelism: false,
    // Vitest's default (5000ms) is too tight for this suite's heaviest
    // integration test under real full-suite load — measured, not guessed:
    // confirmPendingReservation.test.ts's "moves to payment_conflict..."
    // test (two real createReservation calls with a FOR UPDATE lock, plus
    // processPaymentReceived) took 3758ms in a full 22-file run with no
    // timeout ceiling, and was previously seen cut off AT the old 5000ms
    // limit in another run (real duration unknown, but ≥5000ms — vitest's
    // testTimeout does NOT cancel the in-flight DB transaction, it only
    // abandons the test, which left that test's locks held and deadlocked
    // the NEXT test's beforeEach TRUNCATE — see testClient.ts's
    // `lock_timeout` for the other half of this fix). 15000ms is ~3x the
    // highest actually-measured completion time for that test, comfortable
    // margin for run-to-run variance under load. This is NOT "raise it
    // until it's green" — if any test ever needs more than ~10s, that's a
    // real regression to investigate, not something this margin is meant
    // to absorb.
    testTimeout: 15000,
  },
});
