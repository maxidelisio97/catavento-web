/**
 * Pure deposit calculation, per SPEC-modulo-4-pago-asaas.md § "Decisiones de
 * negocio": depositPercent of totalCents, rounded half-up to whole reais
 * (multiples of 100 cents). The remaining balance (total - deposit) absorbs
 * the rounding and is collected at the pousada, outside this system.
 */

/**
 * @param totalCents Frozen total price of the stay, in cents.
 * @param depositPercent Whole percentage (0-100), e.g. 50.
 */
export function calculateDeposit(totalCents: number, depositPercent: number): number {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new Error('totalCents must be a non-negative integer');
  }
  if (!Number.isInteger(depositPercent) || depositPercent < 0 || depositPercent > 100) {
    throw new Error('depositPercent must be an integer between 0 and 100');
  }

  // Integer-only half-up rounding to the nearest 100 cents: scale by 100
  // (percent is already a fraction of 100, so totalCents*percent is in
  // "cents * 100"), add half of the 10000 rounding unit, then floor-divide.
  // This never touches floating point, so it can't misround money.
  const numerator = totalCents * depositPercent + 5000;
  return Math.floor(numerator / 10000) * 100;
}
