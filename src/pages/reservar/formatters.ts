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

/**
 * Masks digits as CPF (000.000.000-00) while there are 11 or fewer, and as
 * CNPJ (00.000.000/0000-00) once there are more — the same mask a Brazilian
 * guest expects to see appear as they type, without asking them to pick
 * which document type upfront. Extra digits beyond a CNPJ are dropped.
 */
export function maskCpfCnpj(rawValue: string): string {
  const digits = rawValue.replace(/\D/g, "").slice(0, 14);

  if (digits.length <= 11) {
    return digits
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  }

  return digits
    .replace(/(\d{2})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1/$2")
    .replace(/(\d{4})(\d{1,2})$/, "$1-$2");
}

/** A CPF has 11 digits, a CNPJ has 14 — anything else is not a valid document. */
export function isValidCpfCnpjLength(rawValue: string): boolean {
  const digits = rawValue.replace(/\D/g, "");
  return digits.length === 11 || digits.length === 14;
}
