/**
 * CLI wrapper for the reservation_nights invariant check — módulo 6A
 * (SPEC-modulo-6-panel-base.md § "6A.3 Invariante"). No auth/panel
 * infrastructure exists yet (that's módulo 6B), so this is a `tsx`-runnable
 * script rather than an HTTP endpoint.
 *
 * Usage: npx tsx scripts/checkReservationNightsConsistency.ts
 * (or: npm run check:reservation-nights)
 *
 * Exits non-zero if any inconsistency is found.
 */
import { db } from '../src/db/client.js';
import { checkReservationNightsConsistency } from '../src/availability/checkReservationNightsConsistency.js';

async function main(): Promise<void> {
  const inconsistencies = await checkReservationNightsConsistency(db);

  if (inconsistencies.length === 0) {
    console.log('reservation_nights consistency check: OK — 0 inconsistencies found.');
    return;
  }

  console.error(`reservation_nights consistency check: FOUND ${inconsistencies.length} inconsistenc(y/ies):`);
  for (const issue of inconsistencies) {
    console.error(
      `  reservation id=${issue.reservationId} code=${issue.code ?? '(none)'}: expected ${issue.expectedNights} night(s), found ${issue.actualNights} row(s)`,
    );
  }
  process.exitCode = 1;
}

main()
  .then(() => db.destroy())
  .catch((err) => {
    console.error(err);
    return db.destroy().finally(() => process.exit(1));
  });
