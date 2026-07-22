import { useEffect, useState } from "react";
import { getReservationDetail, type ReservationDetail } from "../../api/tapeChart";
import { formatDateDisplay, formatMoneyCents } from "../../lib/dateUtils";

interface ReservationDrawerProps {
  reservationId: number;
  onClose: () => void;
}

const ORIGIN_LABELS: Record<string, string> = { web: "Site", manual: "Manual", ota: "OTA" };
const STATUS_LABELS: Record<string, string> = {
  pending_payment: "Pagamento pendente",
  confirmed: "Confirmada",
  cancelled: "Cancelada",
  payment_conflict: "Conflito de pagamento",
};

function whatsappHref(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `https://wa.me/${digits}`;
}

export default function ReservationDrawer({ reservationId, onClose }: ReservationDrawerProps) {
  const [detail, setDetail] = useState<ReservationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entered, setEntered] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    getReservationDetail(reservationId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch(() => {
        if (!cancelled) setError("Não foi possível carregar a reserva.");
      });
    return () => {
      cancelled = true;
    };
  }, [reservationId]);

  // SPEC § 6C.4: cierra con Escape, con clic fuera y con botón explícito.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function copyCode(code: string) {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Detalhe da reserva"
        onClick={(e) => e.stopPropagation()}
        className={[
          "h-full w-full md:max-w-md bg-white shadow-xl overflow-y-auto p-6 flex flex-col gap-5",
          "motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out",
          entered ? "translate-x-0" : "motion-safe:translate-x-full",
        ].join(" ")}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-panel-900">Detalhe da reserva</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="text-panel-500 hover:text-panel-900 text-xl leading-none px-1"
          >
            ×
          </button>
        </div>

        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

        {!detail && !error && <p className="text-sm text-panel-500">Carregando...</p>}

        {detail && (
          <>
            <div>
              <p className="text-lg font-semibold text-panel-900">{detail.contact.name ?? "—"}</p>
              {detail.code && (
                <button
                  type="button"
                  onClick={() => copyCode(detail.code!)}
                  className="text-sm text-panel-500 hover:text-panel-900 flex items-center gap-1"
                >
                  {detail.code} <span className="text-xs">{copied ? "(copiado)" : "(copiar)"}</span>
                </button>
              )}
            </div>

            <section className="text-sm">
              <p className="text-panel-500">Datas</p>
              <p className="text-panel-900">
                {formatDateDisplay(detail.arrival)} → {formatDateDisplay(detail.departure)} · {detail.nights}{" "}
                {detail.nights === 1 ? "noite" : "noites"}
              </p>
            </section>

            <section className="text-sm">
              <p className="text-panel-500">Quarto</p>
              <p className="text-panel-900">{detail.room_type.name}</p>
              {detail.units.length > 1 && new Set(detail.units.map((u) => u.unit_label)).size > 1 ? (
                <ul className="mt-1 text-panel-700 text-xs flex flex-col gap-0.5">
                  {detail.units.map((u) => (
                    <li key={u.night}>
                      {formatDateDisplay(u.night)}: unidade {u.unit_label}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-panel-700 text-xs">Unidade {detail.units[0]?.unit_label ?? "—"}</p>
              )}
            </section>

            <section className="text-sm">
              <p className="text-panel-500">Hóspedes</p>
              <p className="text-panel-900">
                {detail.guests.adults} {detail.guests.adults === 1 ? "adulto" : "adultos"}
                {detail.guests.children > 0 &&
                  `, ${detail.guests.children} ${detail.guests.children === 1 ? "criança" : "crianças"} (${detail.guests.children_ages.join(", ")} anos)`}
                {detail.guests.babies > 0 && `, ${detail.guests.babies} bebê(s)`}
              </p>
            </section>

            <section className="text-sm">
              <p className="text-panel-500">Financeiro</p>
              <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-panel-900">
                <dt className="text-panel-500">Total</dt>
                <dd>{formatMoneyCents(detail.money.total_cents)}</dd>
                <dt className="text-panel-500">Depósito</dt>
                <dd>{detail.money.deposit_cents != null ? formatMoneyCents(detail.money.deposit_cents) : "—"}</dd>
                <dt className="text-panel-500">Pago</dt>
                <dd>{formatMoneyCents(detail.money.paid_cents)}</dd>
                <dt className="text-panel-500">Saldo</dt>
                <dd className={detail.money.balance_cents > 0 ? "font-semibold text-amber-700" : ""}>
                  {formatMoneyCents(detail.money.balance_cents)}
                </dd>
              </dl>
            </section>

            <section className="text-sm">
              <p className="text-panel-500">Origem</p>
              <p className="text-panel-900">{ORIGIN_LABELS[detail.origin] ?? detail.origin}</p>
            </section>

            <section className="text-sm">
              <p className="text-panel-500">Contato</p>
              <p className="text-panel-900">{detail.contact.name ?? "—"}</p>
              <p className="text-panel-900">{detail.contact.email ?? "—"}</p>
              {detail.contact.phone ? (
                <a
                  href={whatsappHref(detail.contact.phone)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent-600 hover:underline"
                >
                  {detail.contact.phone} (WhatsApp)
                </a>
              ) : (
                <p className="text-panel-900">—</p>
              )}
            </section>

            {detail.comments && (
              <section className="text-sm">
                <p className="text-panel-500">Comentários</p>
                <p className="text-panel-900 whitespace-pre-wrap">{detail.comments}</p>
              </section>
            )}

            <p className="text-xs text-panel-500 mt-auto pt-4 border-t border-panel-100">
              {STATUS_LABELS[detail.status] ?? detail.status} · criada em {formatDateDisplay(detail.created_at.slice(0, 10))}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
