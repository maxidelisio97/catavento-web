/*
 * Paso 4 de /reservar: reserva criada (pending_payment). Mostra codigo,
 * resumo, aviso de 30 minutos e placeholder do pagamento (modulo 4).
 */
import { useEffect, useState } from "react";
import { LuClock, LuCircleCheck } from "react-icons/lu";
import type { ReservationResponse } from "../../lib/api";
import { formatCents, formatIsoDateLabel } from "./formatters";

function useCountdown(expiresAt: string | null) {
  const [remainingMs, setRemainingMs] = useState(() => (expiresAt ? new Date(expiresAt).getTime() - Date.now() : 0));

  useEffect(() => {
    if (!expiresAt) return;
    const interval = window.setInterval(() => {
      setRemainingMs(new Date(expiresAt).getTime() - Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, [expiresAt]);

  return remainingMs;
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function ConfirmationStep({ reservation }: { reservation: ReservationResponse }) {
  const remainingMs = useCountdown(reservation.expires_at);
  const expired = remainingMs <= 0;

  return (
    <div className="w-full max-w-md mx-auto space-y-6 text-center">
      <div className="flex justify-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-coral-100 text-coral-600">
          <LuCircleCheck size={28} aria-hidden />
        </div>
      </div>

      <div>
        <h2 className="font-heading text-2xl text-warm-900">Reserva criada!</h2>
        <p className="mt-1 font-body text-sm text-warm-800/60">
          Guarde este código: você pode usá-lo para falar com a pousada por WhatsApp.
        </p>
      </div>

      <p className="font-heading text-3xl tracking-[0.15em] text-coral-600">{reservation.code}</p>

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

      {!expired ? (
        <p className="flex items-center justify-center gap-1.5 font-body text-sm text-warm-800/70">
          <LuClock size={16} aria-hidden />
          Sua reserva fica reservada por mais <span className="font-semibold tabular-nums">{formatCountdown(remainingMs)}</span>
        </p>
      ) : (
        <p className="font-body text-sm text-coral-600">O tempo para pagamento expirou.</p>
      )}

      <div className="rounded-2xl border border-dashed border-stone-300 bg-sand-50 p-5">
        <p className="font-body text-sm text-warm-800/60">
          Aqui vai o pagamento (PIX ou cartão) — em breve.
        </p>
      </div>
    </div>
  );
}
