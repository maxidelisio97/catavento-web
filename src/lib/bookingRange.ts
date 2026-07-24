/*
 * Utilidades de rango de fechas compartidas entre BookingForm.tsx (form
 * principal) y RoomBookingModal.tsx (drawer de reserva por habitacao).
 */
import type { DateRange } from "react-day-picker";

export function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

export function isSameDay(a: Date, b: Date) {
  return a.getTime() === b.getTime();
}

// react-day-picker fixa `to = from` no primeiro clique de um range (nao fica
// undefined) — "ainda escolhendo o check-out" significa from existe e to
// ainda nao e uma data distinta e posterior.
export function isPickingCheckout(range: DateRange | undefined) {
  return Boolean(range?.from) && (!range?.to || isSameDay(range.to, range.from!));
}

const rangeDateFormatter = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" });

export function formatRangeLabel(range: DateRange | undefined) {
  if (!range?.from) return "Adicionar datas";
  if (isPickingCheckout(range)) return `${rangeDateFormatter.format(range.from)} — ?`;
  return `${rangeDateFormatter.format(range.from)} — ${rangeDateFormatter.format(range.to!)}`;
}
