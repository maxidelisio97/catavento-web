export function formatCents(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

// timeZone: "UTC" is load-bearing: the Date below is built via Date.UTC,
// but Intl.DateTimeFormat renders in the viewer's local timezone by
// default — without pinning it, a viewer behind UTC sees the day before.
const dateLabelFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** Formats an ISO 'YYYY-MM-DD' date string without timezone drift. */
export function formatIsoDateLabel(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return dateLabelFormatter.format(new Date(Date.UTC(year, month - 1, day)));
}
