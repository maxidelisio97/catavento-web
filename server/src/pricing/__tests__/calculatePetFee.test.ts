import { describe, expect, it } from 'vitest';
import { calculatePetFee } from '../calculatePetFee.js';

describe('calculatePetFee', () => {
  it('multiplies nights by the flat per-night rate', () => {
    expect(calculatePetFee(3, 3000)).toBe(9000);
  });

  it('is flat per reservation, not per pet — caller passes nights once regardless of pet count', () => {
    expect(calculatePetFee(1, 3000)).toBe(3000);
  });

  it('is zero for a zero-night stay', () => {
    expect(calculatePetFee(0, 3000)).toBe(0);
  });

  it('is zero when the fee itself is zero', () => {
    expect(calculatePetFee(5, 0)).toBe(0);
  });

  it('rejects a negative nights', () => {
    expect(() => calculatePetFee(-1, 3000)).toThrow();
  });

  it('rejects a negative fee', () => {
    expect(() => calculatePetFee(3, -100)).toThrow();
  });

  it('is a pure function: changing the setting later does not affect a value already computed', () => {
    const frozenAt3000 = calculatePetFee(4, 3000);
    const laterAt5000 = calculatePetFee(4, 5000);

    expect(frozenAt3000).toBe(12000);
    expect(laterAt5000).toBe(20000);
    expect(frozenAt3000).not.toBe(laterAt5000);
  });
});
