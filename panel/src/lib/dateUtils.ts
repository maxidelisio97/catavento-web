// Mirrors server/src/shared/dateUtils.ts's UTC convention — every date the
// backend hands the panel (night, check_in, check_out) is a bare calendar
// date, never a timezone-aware instant. Parsing/formatting in UTC here
// avoids the classic "midnight rolls back a day" bug on any machine not set
// to UTC.
export function parseDateUTC(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function formatDateUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDaysUTC(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function todayISO(): string {
  return formatDateUTC(new Date());
}

/** Every night in [from, to), as 'YYYY-MM-DD' strings — same convention as the backend. */
export function eachNightUTC(from: string, to: string): string[] {
  const nights: string[] = [];
  let cursor = parseDateUTC(from);
  const end = parseDateUTC(to);
  while (cursor.getTime() < end.getTime()) {
    nights.push(formatDateUTC(cursor));
    cursor = addDaysUTC(cursor, 1);
  }
  return nights;
}

// Weekend = Friday/Saturday nights, per server/CLAUDE.md § "Convenciones de
// datos" — matches the rate model, not the calendar-week definition.
export function isWeekendNight(night: string): boolean {
  const day = parseDateUTC(night).getUTCDay();
  return day === 5 || day === 6;
}

const WEEKDAY_LABELS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

export function shortWeekday(night: string): string {
  return WEEKDAY_LABELS[parseDateUTC(night).getUTCDay()];
}

export function dayOfMonth(night: string): number {
  return parseDateUTC(night).getUTCDate();
}

export function formatDateDisplay(date: string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(parseDateUTC(date));
}

export function formatMoneyCents(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

/** `monthISO` is always 'YYYY-MM' (matches `<input type="month">`'s value format). */
export function addMonthsUTC(monthISO: string, delta: number): string {
  const [year, month] = monthISO.split("-").map(Number);
  const total = year * 12 + (month - 1) + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12) + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
}

const MONTH_LABELS = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

export function monthLabel(monthISO: string): string {
  const [year, month] = monthISO.split("-").map(Number);
  const name = MONTH_LABELS[month - 1]!;
  return `${name[0]!.toUpperCase()}${name.slice(1)} de ${year}`;
}

/**
 * 42-day grid (6 weeks, Sunday-first) covering `monthISO`, padded with
 * adjacent-month dates for layout continuity — a fixed 6 rows avoids the
 * grid's height jumping between 4-and 5-week months.
 */
export function buildMonthGrid(monthISO: string): string[] {
  const first = parseDateUTC(`${monthISO}-01`);
  const gridStart = addDaysUTC(first, -first.getUTCDay());
  return Array.from({ length: 42 }, (_, i) => formatDateUTC(addDaysUTC(gridStart, i)));
}

export function isInMonth(date: string, monthISO: string): boolean {
  return date.startsWith(monthISO);
}
