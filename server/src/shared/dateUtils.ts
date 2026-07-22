/** Parses a 'YYYY-MM-DD' date as a UTC calendar date (no time-zone drift). */
export function parseDateUTC(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
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

/** Every night in [checkIn, checkOut), as 'YYYY-MM-DD' strings. */
export function eachNightUTC(checkIn: string, checkOut: string): string[] {
  const nights: string[] = [];
  let cursor = parseDateUTC(checkIn);
  const end = parseDateUTC(checkOut);
  while (cursor.getTime() < end.getTime()) {
    nights.push(formatDateUTC(cursor));
    cursor = addDaysUTC(cursor, 1);
  }
  return nights;
}

/** Today's date as 'YYYY-MM-DD', UTC-based — consistent with every other date in the system. */
export function todayISO(): string {
  return formatDateUTC(new Date());
}
