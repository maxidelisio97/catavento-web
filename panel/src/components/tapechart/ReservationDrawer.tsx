import { useEffect, useState } from "react";
import { getReservationDetail, type ReservationDetail } from "../../api/tapeChart";
import {
  checkIn,
  checkOut,
  registerPayment,
  type PanelPaymentKind,
  type PanelPaymentMethod,
  type RegisterPaymentResult,
} from "../../api/reservationActions";
import { ApiError } from "../../api/client";
import { formatDateDisplay, formatMoneyCents } from "../../lib/dateUtils";
import Button from "../ui/Button";
import Card from "../ui/Card";
import StatusBadge from "../ui/StatusBadge";
import { SelectField, TextField } from "../ui/Field";

interface ReservationDrawerProps {
  reservationId: number;
  onClose: () => void;
  /** Called after check-in/check-out/payment succeeds, so the tape chart behind can refresh. */
  onChanged?: () => void;
  /** SPEC-modulo-9-usuarios-permisos.md § 6: effective permission check from usePermissions(). */
  can: (permission: string) => boolean;
}

const NO_PERMISSION_MESSAGE = "Você não tem permissão para essa ação.";

const PAYMENT_KIND_LABELS: Record<PanelPaymentKind, string> = {
  deposit: "Depósito",
  balance: "Saldo",
  extra: "Extra",
};

// payments.charge covers deposit/balance, payments.extra covers the extra
// kind — same split as the backend gate (SPEC § 6, "el botón se muestra si
// tiene payments.charge O payments.extra; el selector de tipo se filtra").
function permissionForPaymentKind(kind: PanelPaymentKind): string {
  return kind === "extra" ? "payments.extra" : "payments.charge";
}

const ORIGIN_LABELS: Record<string, string> = { web: "Site", manual: "Manual", ota: "OTA" };

// SPEC-modulo-7-gestion-operativa.md § 5 — states with no outgoing
// transition that could ever need a new payment (mirrors the backend's
// NOT_PAYABLE_STATUSES in panel/reservationActions.ts).
const NOT_PAYABLE_STATUSES = new Set(["cancelled", "no_show", "checked_out", "payment_conflict"]);

const PAYMENT_METHOD_LABELS: Record<PanelPaymentMethod, string> = {
  asaas_pix: "PIX (Asaas)",
  asaas_card: "Cartão (Asaas)",
  cash: "Dinheiro",
  external: "Transferência",
  pix_manual: "PIX direto",
};

// SPEC § 6: a 403 here means the UI was out of sync with the effective
// permission (stale usePermissions() cache, or a gate this drawer missed) —
// the backend is the real barrier, this is just presenting that rejection
// clearly instead of a generic/crude error.
function describeActionError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.status === 403 ? NO_PERMISSION_MESSAGE : err.message;
  }
  return fallback;
}

function whatsappHref(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `https://wa.me/${digits}`;
}

export default function ReservationDrawer({ reservationId, onClose, onChanged, can }: ReservationDrawerProps) {
  const [detail, setDetail] = useState<ReservationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entered, setEntered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [version, setVersion] = useState(0);

  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentKind, setPaymentKind] = useState<PanelPaymentKind>("balance");
  const [paymentMethod, setPaymentMethod] = useState<PanelPaymentMethod>("cash");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentCpf, setPaymentCpf] = useState("");
  const [paymentResult, setPaymentResult] = useState<RegisterPaymentResult | null>(null);
  // Generated once when the form opens, not per submit — so retries of the
  // SAME intent (double-click, or resubmit after a hung request) reuse it
  // and dedupe server-side, while closing and reopening the form to register
  // a second, legitimately identical payment gets a fresh key.
  const [paymentIdempotencyKey, setPaymentIdempotencyKey] = useState<string | null>(null);

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
  }, [reservationId, version]);

  function reload() {
    setVersion((v) => v + 1);
    onChanged?.();
  }

  async function handleCheckIn() {
    setActionBusy(true);
    setActionError(null);
    try {
      await checkIn(detail!.code!);
      reload();
    } catch (err) {
      setActionError(describeActionError(err, "Não foi possível fazer o check-in."));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleCheckOut() {
    setActionBusy(true);
    setActionError(null);
    try {
      await checkOut(detail!.code!);
      reload();
    } catch (err) {
      setActionError(describeActionError(err, "Não foi possível fazer o check-out."));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleRegisterPayment(e: React.FormEvent) {
    e.preventDefault();
    const amountCents = Math.round(Number(paymentAmount.replace(",", ".")) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setActionError("Informe um valor válido.");
      return;
    }
    const isAsaas = paymentMethod === "asaas_pix" || paymentMethod === "asaas_card";
    if (isAsaas && paymentCpf.trim().length < 11) {
      setActionError("CPF/CNPJ é obrigatório para pagamento via Asaas.");
      return;
    }

    setActionBusy(true);
    setActionError(null);
    try {
      const result = await registerPayment(detail!.code!, {
        kind: paymentKind,
        method: paymentMethod,
        amount_cents: amountCents,
        cpf_cnpj: isAsaas ? paymentCpf.trim() : undefined,
        idempotency_key: paymentIdempotencyKey ?? undefined,
      });
      setPaymentResult(result);
      if (result.method !== "pix" && result.method !== "card") {
        // Manual payment: already 'received', nothing more for the operator
        // to do — refresh the balance right away.
        reload();
      }
    } catch (err) {
      setActionError(describeActionError(err, "Não foi possível registrar o pagamento."));
    } finally {
      setActionBusy(false);
    }
  }

  const canCharge = can("payments.charge");
  const canExtra = can("payments.extra");
  const allowedPaymentKinds = (Object.keys(PAYMENT_KIND_LABELS) as PanelPaymentKind[]).filter((kind) =>
    can(permissionForPaymentKind(kind)),
  );

  function openPaymentForm() {
    setPaymentIdempotencyKey(crypto.randomUUID());
    // Default to a kind the user can actually submit — e.g. someone with
    // only payments.extra must not land on the disallowed "balance" default.
    if (allowedPaymentKinds.length > 0 && !allowedPaymentKinds.includes(paymentKind)) {
      setPaymentKind(allowedPaymentKinds[0]!);
    }
    setShowPaymentForm(true);
  }

  function closePaymentForm() {
    setShowPaymentForm(false);
    setPaymentResult(null);
    setPaymentAmount("");
    setPaymentCpf("");
    setPaymentIdempotencyKey(null);
    setActionError(null);
    // A pix/card charge only settles later via webhook — reload now so the
    // ficha shows the fresh 'pending' payment even before it's received.
    reload();
  }

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
          <h2 className="text-[15px] font-semibold text-panel-900">Detalhe da reserva</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="text-panel-500 hover:text-panel-900 hover:bg-panel-100 text-xl leading-none rounded-panel-sm px-2 py-1 transition-colors"
          >
            ×
          </button>
        </div>

        {error && <p role="alert" className="text-sm text-danger-500">{error}</p>}

        {!detail && !error && <p className="text-sm text-panel-500">Carregando...</p>}

        {detail && (
          <>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <p className="text-[17px] font-semibold text-panel-900">{detail.contact.name ?? "—"}</p>
                <StatusBadge status={detail.status} />
              </div>
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
                <dd className={detail.money.balance_cents > 0 ? "font-semibold text-warning-700" : ""}>
                  {formatMoneyCents(detail.money.balance_cents)}
                </dd>
              </dl>
            </section>

            <section className="text-sm flex flex-col gap-2">
              <p className="text-panel-500">Ações</p>

              {actionError && (
                <p role="alert" className="text-xs text-danger-500">
                  {actionError}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                {detail.status === "confirmed" && (
                  <Button
                    size="sm"
                    onClick={handleCheckIn}
                    disabled={actionBusy || !can("reservations.checkin")}
                    title={!can("reservations.checkin") ? NO_PERMISSION_MESSAGE : undefined}
                  >
                    Check-in
                  </Button>
                )}

                {detail.status === "checked_in" && (
                  <Button
                    size="sm"
                    onClick={handleCheckOut}
                    disabled={actionBusy || !can("reservations.checkout") || detail.money.balance_cents > 0}
                    title={
                      !can("reservations.checkout")
                        ? NO_PERMISSION_MESSAGE
                        : detail.money.balance_cents > 0
                          ? `Falta cobrar ${formatMoneyCents(detail.money.balance_cents)} — registre o pagamento para poder fechar`
                          : undefined
                    }
                  >
                    Check-out
                  </Button>
                )}
                {detail.status === "checked_in" && detail.money.balance_cents > 0 && (
                  <p className="w-full text-xs text-warning-700">
                    Falta cobrar {formatMoneyCents(detail.money.balance_cents)} para poder fechar o check-out.
                  </p>
                )}

                {!NOT_PAYABLE_STATUSES.has(detail.status) && (canCharge || canExtra) && (
                  <Button size="sm" onClick={() => (showPaymentForm ? closePaymentForm() : openPaymentForm())}>
                    Registrar pagamento
                  </Button>
                )}
              </div>

              {showPaymentForm && (
                <Card className="p-3 flex flex-col gap-2">
                  {paymentResult ? (
                    <div className="flex flex-col gap-2 text-xs">
                      {paymentResult.method === "pix" && (
                        <>
                          <img
                            src={`data:image/png;base64,${paymentResult.qr_code.encoded_image}`}
                            alt="QR code PIX"
                            className="h-40 w-40"
                          />
                          <button
                            type="button"
                            onClick={() => navigator.clipboard.writeText(paymentResult.qr_code.payload)}
                            className="text-accent-700 hover:underline text-left"
                          >
                            Copiar código PIX
                          </button>
                        </>
                      )}
                      {paymentResult.method === "card" && (
                        <a
                          href={paymentResult.invoice_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent-700 hover:underline"
                        >
                          Abrir link de pagamento
                        </a>
                      )}
                      {(paymentResult.method === "cash" ||
                        paymentResult.method === "external" ||
                        paymentResult.method === "pix_manual") && (
                        <p className="text-panel-900">Pagamento registrado.</p>
                      )}
                      <Button size="sm" onClick={closePaymentForm} className="self-start">
                        Fechar
                      </Button>
                    </div>
                  ) : (
                    <form onSubmit={handleRegisterPayment} className="flex flex-col gap-3">
                      <SelectField
                        id="payment-kind"
                        label="Tipo"
                        value={paymentKind}
                        onChange={(e) => setPaymentKind(e.target.value as PanelPaymentKind)}
                      >
                        {allowedPaymentKinds.map((kind) => (
                          <option key={kind} value={kind}>
                            {PAYMENT_KIND_LABELS[kind]}
                          </option>
                        ))}
                      </SelectField>
                      <SelectField
                        id="payment-method"
                        label="Forma de pagamento"
                        value={paymentMethod}
                        onChange={(e) => setPaymentMethod(e.target.value as PanelPaymentMethod)}
                      >
                        {(Object.keys(PAYMENT_METHOD_LABELS) as PanelPaymentMethod[]).map((method) => (
                          <option key={method} value={method}>
                            {PAYMENT_METHOD_LABELS[method]}
                          </option>
                        ))}
                      </SelectField>
                      <TextField
                        id="payment-amount"
                        label="Valor (R$)"
                        type="text"
                        inputMode="decimal"
                        value={paymentAmount}
                        onChange={(e) => setPaymentAmount(e.target.value)}
                        placeholder="0,00"
                      />
                      {(paymentMethod === "asaas_pix" || paymentMethod === "asaas_card") && (
                        <TextField
                          id="payment-cpf"
                          label="CPF/CNPJ do hóspede"
                          type="text"
                          value={paymentCpf}
                          onChange={(e) => setPaymentCpf(e.target.value)}
                        />
                      )}
                      <div className="flex gap-2">
                        <Button type="submit" variant="primary" size="sm" disabled={actionBusy}>
                          Confirmar
                        </Button>
                        <Button type="button" size="sm" onClick={closePaymentForm}>
                          Cancelar
                        </Button>
                      </div>
                    </form>
                  )}
                </Card>
              )}
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
                  className="text-accent-700 hover:underline"
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
              Criada em {formatDateDisplay(detail.created_at.slice(0, 10))}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
