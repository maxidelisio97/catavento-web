import { describe, expect, it } from 'vitest';
import { calculateDeposit } from '../calculateDeposit.js';

describe('calculateDeposit', () => {
  it('50% of 58000 is exact -> 29000', () => {
    expect(calculateDeposit(58000, 50)).toBe(29000);
  });

  it('50% of 12500 is 6250, rounds half-up to the nearest real -> 6300', () => {
    expect(calculateDeposit(12500, 50)).toBe(6300);
  });

  it('rounds a non-half fraction down when closer to the lower real', () => {
    // 30% of 10100 = 3030 -> nearest 100 is 3000 (30.3 rounds down).
    expect(calculateDeposit(10100, 30)).toBe(3000);
  });

  it('rounds a non-half fraction up when closer to the higher real', () => {
    // 30% of 10200 = 3060 -> nearest 100 is 3100 (30.6 rounds up).
    expect(calculateDeposit(10200, 30)).toBe(3100);
  });

  it('is a pure function: changing the percent later does not affect a value already computed', () => {
    const frozenAt50 = calculateDeposit(58000, 50);
    const laterAt60 = calculateDeposit(58000, 60);

    expect(frozenAt50).toBe(29000);
    expect(laterAt60).toBe(34800);
    expect(frozenAt50).not.toBe(laterAt60);
  });

  it('rejects a negative totalCents', () => {
    expect(() => calculateDeposit(-100, 50)).toThrow();
  });

  it('rejects an out-of-range percent', () => {
    expect(() => calculateDeposit(10000, 150)).toThrow();
  });
});
