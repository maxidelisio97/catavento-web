/*
 * Countdown compartido entre ConfirmationStep e PixPayment. Extraido do
 * ConfirmationStep original (modulo 3) para reuso no fluxo de pagamento
 * (modulo 4): a mesma logica agora conta tanto o prazo de retencao da
 * reserva quanto, futuramente, qualquer outro prazo baseado em ISO string.
 */
import { useEffect, useState } from "react";

export function useCountdown(expiresAt: string | null): number {
  const [remainingMs, setRemainingMs] = useState(() => (expiresAt ? new Date(expiresAt).getTime() - Date.now() : 0));

  useEffect(() => {
    if (!expiresAt) return;
    setRemainingMs(new Date(expiresAt).getTime() - Date.now());
    const interval = window.setInterval(() => {
      setRemainingMs(new Date(expiresAt).getTime() - Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, [expiresAt]);

  return remainingMs;
}

export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
