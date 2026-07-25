/**
 * Pure pet fee calculation, per SPEC-modulo-7-gestion-operativa.md § 7.2b:
 * a flat charge per night, per RESERVATION (not per pet — a reservation with
 * two pets still pays a single per-night rate). `petFeeCentsPerNight` comes
 * from `settings.pet_fee_cents` (server/CLAUDE.md § "parámetros de negocio
 * como datos"), never hardcoded here.
 */

/**
 * @param nights Number of nights in the stay.
 * @param petFeeCentsPerNight `settings.pet_fee_cents` at the moment of
 *   creation — the caller freezes this by reading it once, same pattern as
 *   `calculateDeposit`'s `depositPercent`.
 */
export function calculatePetFee(nights: number, petFeeCentsPerNight: number): number {
  if (!Number.isInteger(nights) || nights < 0) {
    throw new Error('nights must be a non-negative integer');
  }
  if (!Number.isInteger(petFeeCentsPerNight) || petFeeCentsPerNight < 0) {
    throw new Error('petFeeCentsPerNight must be a non-negative integer');
  }

  return nights * petFeeCentsPerNight;
}
