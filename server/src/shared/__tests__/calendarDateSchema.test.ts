/**
 * D9 (design: nova-reserva-panel) — a real-calendar 'YYYY-MM-DD' schema,
 * distinct from the transversal `dateSchema` regex already repeated across
 * the panel (server/CLAUDE.md "Deuda conocida": that regex validates
 * format, not calendar, so '2026-13-45' passes it and crashes Postgres as
 * a raw 500). This is a new shared home for the free-units endpoint and
 * the new preferred-unit body field only — not a fix to the existing regex,
 * which stays out of scope here.
 */
import { describe, expect, it } from 'vitest';
import { calendarDateSchema } from '../calendarDateSchema.js';

describe('calendarDateSchema', () => {
  it('accepts a real calendar date', () => {
    expect(calendarDateSchema.safeParse('2026-10-05').success).toBe(true);
  });

  it('accepts a leap-day date in a leap year', () => {
    expect(calendarDateSchema.safeParse('2028-02-29').success).toBe(true);
  });

  it('rejects a non-existent month', () => {
    expect(calendarDateSchema.safeParse('2026-13-01').success).toBe(false);
  });

  it('rejects a non-existent day for a real month', () => {
    expect(calendarDateSchema.safeParse('2026-04-31').success).toBe(false);
  });

  it('rejects a nonsense date that a naive regex would still let through', () => {
    expect(calendarDateSchema.safeParse('2026-13-45').success).toBe(false);
  });

  it('rejects Feb 29 in a non-leap year', () => {
    expect(calendarDateSchema.safeParse('2026-02-29').success).toBe(false);
  });

  it('rejects a malformed string with the wrong shape', () => {
    expect(calendarDateSchema.safeParse('2026/10/05').success).toBe(false);
  });

  it('rejects a string with extra characters', () => {
    expect(calendarDateSchema.safeParse('2026-10-05T00:00:00Z').success).toBe(false);
  });

  it('rejects a non-string value', () => {
    expect(calendarDateSchema.safeParse(20261005).success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(calendarDateSchema.safeParse('').success).toBe(false);
  });
});
