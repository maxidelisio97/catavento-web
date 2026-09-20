/**
 * D9 (design: nova-reserva-panel) — a real-calendar 'YYYY-MM-DD' schema.
 *
 * The transversal `dateSchema` repeated across the panel (`panelTapeChart.ts`,
 * `panelMoveReservation.ts`, `panelManualReservation.ts`, `reservations.ts`,
 * `availability.ts`) is only `/^\d{4}-\d{2}-\d{2}$/` — format, not calendar
 * (server/CLAUDE.md "Deuda conocida"). A value like '2026-13-45' passes that
 * regex and crashes as a raw 500 at Postgres's `::date` cast.
 *
 * This is a NEW shared home, used by the free-units endpoint and its new
 * body field only — not a fix applied to the six existing endpoints above,
 * which is separate, transversal cleanup out of scope here.
 *
 * Validation strategy: regex for shape, then a `Date.UTC` roundtrip check —
 * `Date.UTC` normalizes out-of-range components (e.g. month 13 rolls into
 * the next year, day 31 in April rolls into May), so re-formatting the
 * parsed value and comparing it back to the input catches anything the
 * JS Date constructor silently "fixed" instead of rejecting.
 */
import { z } from 'zod';

const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const calendarDateSchema = z.string().refine((value) => {
  const match = CALENDAR_DATE_RE.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const utcMs = Date.UTC(year, month - 1, day);
  if (Number.isNaN(utcMs)) return false;

  const roundtrip = new Date(utcMs);
  return (
    roundtrip.getUTCFullYear() === year &&
    roundtrip.getUTCMonth() === month - 1 &&
    roundtrip.getUTCDate() === day
  );
}, 'Expected a real calendar date in YYYY-MM-DD format');
