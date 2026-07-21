/*
 * Paso 4 de /reservar: reserva criada. Mostra codigo, resumo, aviso de 30
 * minutos e o fluxo de pagamento do deposito (modulo 4): escolha de metodo
 * -> PIX (QR + polling) ou cartao (redirect para o Asaas) -> confirmacao,
 * ou os estados de erro (expirada / conflito / falha ao criar cobranca).
 *
 * Tambem e o ponto de entrada quando o huesped volta via /reservar?code=XXXX
 * (redirect do Asaas apos pagar com cartao) — ver readCodeFromUrl em
 * ReservarPage.tsx.
 */
import { useEffect, useState } from "react";
import { LuCheck, LuCircleCheck, LuClock, LuCopy, LuLoaderCircle } from "react-icons/lu";
import { ApiError, fetchReservationByCode, requestPayment, type ReservationResponse } from "../../lib/api";
import type { DatesStepInitial } from "./DatesStep";
import { formatCents, formatIsoDateLabel } from "./formatters";
import { formatCountdown, useCountdown } from "./countdown";
import PaymentMethodForm from "./PaymentMethodForm";
import PixPayment from "./PixPayment";

interface ConfirmationStepProps {
  reservation: ReservationResponse;
  onRestart: (initial: DatesStepInitial) => void;
}

interface PixData {
  encodedImage: string;
  payload: string;
}

export default function ConfirmationStep({ reservation: initialReservation, onRestart }: ConfirmationStepProps) {
  const [reservation, setReservation] = useState(initialReservation);
  const [pix, setPix] = useState<PixData | null>(
    initialReservation.payment?.method === "pix" && initialReservation.payment.pix
      ? {
          encodedImage: initialReservation.payment.pix.encoded_image,
          payload: initialReservation.payment.pix.payload,
        }
      : null,
  );
  // Se a reserva ja chega com um pagamento de cartao criado (volta do redirect
  // do Asaas), so falta aguardar o webhook confirmar — nunca mostra o form de
  // novo nem cria um segundo pagamento.
  const [awaitingCard] = useState(
    initialReservation.status === "pending_payment" && initialReservation.payment?.method === "card",
  );
  const [submitting, setSubmitting] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  const [codeCopied, setCodeCopied] = useState(false);

  const remainingMs = useCountdown(reservation.expires_at);
  const paymentInFlight = pix !== null || awaitingCard;

  async function handleCopyCode() {
    try {
      await navigator.clipboard.writeText(reservation.code);
      setCodeCopied(true);
      window.setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      // clipboard indisponivel — o codigo ja esta visivel na tela.
    }
  }

  // Poll enquanto houver um pagamento em andamento, ate a reserva sair de
  // pending_payment (confirmed / expired / payment_conflict).
  useEffect(() => {
    if (reservation.status !== "pending_payment" || !paymentInFlight) return;
    let cancelled = false;
    const interval = window.setInterval(async () => {
      try {
        const fresh = await fetchReservationByCode(reservation.code);
        if (!cancelled) setReservation(fresh);
      } catch {
        // falha transitoria de rede durante o polling — tenta de novo no proximo tick.
      }
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [reservation.status, reservation.code, paymentInFlight]);

  async function handleSubmitPayment(method: "pix" | "card", cpfCnpj: string) {
    setSubmitting(true);
    setPaymentError(null);
    try {
      const result = await requestPayment(reservation.code, { method, cpf_cnpj: cpfCnpj });
      if (result.method === "pix") {
        setPix({ encodedImage: result.qr_code.encoded_image, payload: result.qr_code.payload });
      } else {
        window.location.href = result.invoice_url;
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Provavelmente a reserva deixou de ser pagavel (expirou entre o
        // carregamento da pagina e o envio) — busca o status real.
        try {
          setReservation(await fetchReservationByCode(reservation.code));
        } catch {
          setPaymentError("Não conseguimos confirmar o status da reserva. Tente novamente.");
        }
      } else {
        setPaymentError(err instanceof ApiError ? err.message : "Não conseguimos iniciar o pagamento. Tente novamente.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleRestart() {
    onRestart({
      checkIn: reservation.check_in,
      checkOut: reservation.check_out,
      guests: reservation.guests,
      errorMessage: "Essa reserva expirou. Escolha as datas novamente para tentar de novo.",
    });
  }

  return (
    <div className="w-full max-w-md mx-auto space-y-6 text-center">
      <div className="flex justify-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-coral-100 text-coral-600">
          <LuCircleCheck size={28} aria-hidden />
        </div>
      </div>

      <div>
        <h2 className="font-heading text-2xl text-warm-900">
          {reservation.status === "confirmed" ? "Reserva confirmada!" : "Reserva criada!"}
        </h2>
        <p className="mt-1 font-body text-sm text-warm-800/60">
          Guarde este código: você pode usá-lo para falar com a pousada por WhatsApp.
        </p>
      </div>

      <div className="flex items-center justify-center gap-2">
        <p className="font-heading text-3xl tracking-[0.05em] text-coral-600">{reservation.code}</p>
        <button
          type="button"
          onClick={handleCopyCode}
          aria-label="Copiar código da reserva"
          className="flex h-9 w-9 items-center justify-center rounded-full text-warm-800/50 hover:text-coral-600 hover:bg-coral-50 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-400"
        >
          {codeCopied ? <LuCheck size={18} aria-hidden /> : <LuCopy size={18} aria-hidden />}
        </button>
      </div>

      <div className="rounded-2xl border border-stone-300 bg-white p-5 text-left space-y-1.5">
        <p className="font-body text-sm text-warm-900">
          <span className="font-semibold">{reservation.room.name}</span>
        </p>
        <p className="font-body text-sm text-warm-800/70">
          {formatIsoDateLabel(reservation.check_in)} — {formatIsoDateLabel(reservation.check_out)}
        </p>
        <p className="font-body text-sm text-warm-800/70">
          {reservation.guests} {reservation.guests === 1 ? "hóspede" : "hóspedes"}
        </p>
        <p className="font-heading text-lg text-warm-900 pt-1">{formatCents(reservation.total_cents)}</p>
      </div>

      {reservation.status === "pending_payment" && (
        <p className="flex items-center justify-center gap-1.5 font-body text-sm text-warm-800/70">
          <LuClock size={16} aria-hidden />
          Sua reserva fica reservada por mais{" "}
          <span className="font-semibold tabular-nums">{formatCountdown(remainingMs)}</span>
        </p>
      )}

      {reservation.status === "confirmed" && (
        <div className="rounded-2xl border border-coral-200 bg-coral-50 p-5 text-left space-y-1.5">
          <p className="font-body text-sm font-semibold text-coral-700">Pagamento confirmado!</p>
          <p className="font-body text-sm text-warm-800/70">
            Depósito pago:{" "}
            <span className="font-semibold text-warm-900">{formatCents(reservation.deposit_cents ?? 0)}</span>
          </p>
          <p className="font-body text-sm text-warm-800/70">
            Saldo a pagar na pousada:{" "}
            <span className="font-semibold text-warm-900">
              {formatCents(reservation.total_cents - (reservation.deposit_cents ?? 0))}
            </span>
          </p>
        </div>
      )}

      {reservation.status === "expired" && (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-sand-50 p-5 space-y-3">
          <p className="font-body text-sm text-warm-800/70">
            O tempo para pagamento expirou e o quarto não ficou mais reservado.
          </p>
          <button
            type="button"
            onClick={handleRestart}
            className="w-full h-12 rounded-xl bg-coral-600 hover:bg-coral-500 text-white font-body font-semibold transition-colors active:scale-[0.98]"
          >
            Começar de novo
          </button>
        </div>
      )}

      {reservation.status === "payment_conflict" && (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-sand-50 p-5">
          <p className="font-body text-sm text-warm-800/70">
            Recebemos seu pagamento, mas tivemos um problema para confirmar a reserva. A pousada vai entrar em
            contato com você para resolver — se preferir, fale direto com a pousada informando o código{" "}
            <span className="font-semibold text-warm-900">{reservation.code}</span>.
          </p>
        </div>
      )}

      {reservation.status === "pending_payment" && !pix && !awaitingCard && (
        <PaymentMethodForm
          depositLabel={formatCents(reservation.deposit_cents ?? 0)}
          submitting={submitting}
          errorMessage={paymentError}
          onSubmit={handleSubmitPayment}
        />
      )}

      {reservation.status === "pending_payment" && pix && (
        <PixPayment encodedImage={pix.encodedImage} payload={pix.payload} expiresAt={reservation.expires_at} />
      )}

      {reservation.status === "pending_payment" && awaitingCard && !pix && (
        <div className="rounded-2xl border border-stone-300 bg-white p-5 flex items-center justify-center gap-2">
          <LuLoaderCircle size={18} className="animate-spin text-coral-600" aria-hidden />
          <p className="font-body text-sm text-warm-800/70">Confirmando seu pagamento…</p>
        </div>
      )}
    </div>
  );
}
