import Badge, { type BadgeTone } from "./Badge";

// SPEC-modulo-7 reservations.status — mapeo fijo aprobado en la propuesta de
// sistema de diseño: el color siempre significa estado, nunca decoración.
const STATUS_TONE: Record<string, BadgeTone> = {
  pending_payment: "warning",
  confirmed: "accent",
  checked_in: "success",
  checked_out: "neutral",
  cancelled: "neutral",
  payment_conflict: "danger",
  no_show: "danger",
};

const STATUS_LABELS: Record<string, string> = {
  pending_payment: "Pagamento pendente",
  confirmed: "Confirmada",
  cancelled: "Cancelada",
  payment_conflict: "Conflito de pagamento",
  checked_in: "Check-in feito",
  checked_out: "Check-out feito",
  no_show: "No-show",
};

interface StatusBadgeProps {
  status: string;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{STATUS_LABELS[status] ?? status}</Badge>;
}
