/*
 * Sub-passo do ConfirmationStep (modulo 4): QR code PIX + copia-e-cola +
 * countdown de expiracao. O countdown usa o expires_at da RESERVA (30min),
 * nao o vencimento do QR do Asaas (que e bem mais longo) — a janela real de
 * pagamento e a da reserva.
 */
import { useState } from "react";
import { LuCheck, LuClock, LuCopy } from "react-icons/lu";
import { formatCountdown, useCountdown } from "./countdown";

interface PixPaymentProps {
  encodedImage: string;
  payload: string;
  expiresAt: string | null;
}

export default function PixPayment({ encodedImage, payload, expiresAt }: PixPaymentProps) {
  const remainingMs = useCountdown(expiresAt);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard indisponivel (permissao, contexto nao seguro) — falha silenciosa,
      // o huesped ainda pode escanear o QR.
    }
  }

  return (
    <div className="rounded-2xl border border-stone-300 bg-white p-5 space-y-4 text-center">
      <p className="font-body text-sm text-warm-800/70">
        Escaneie o QR Code com o app do seu banco ou copie o código abaixo.
      </p>

      <div className="flex justify-center">
        <img
          src={`data:image/png;base64,${encodedImage}`}
          alt="QR Code PIX para pagamento do depósito"
          className="h-48 w-48 rounded-xl border border-stone-200"
        />
      </div>

      <button
        type="button"
        onClick={handleCopy}
        className="w-full h-12 rounded-xl border border-stone-300 bg-sand-50 font-body text-sm font-semibold text-warm-900 hover:border-stone-400 transition-colors flex items-center justify-center gap-2"
      >
        {copied ? <LuCheck size={16} aria-hidden /> : <LuCopy size={16} aria-hidden />}
        {copied ? "Copiado!" : "Copiar código PIX"}
      </button>

      {expiresAt && remainingMs > 0 && (
        <p className="flex items-center justify-center gap-1.5 font-body text-sm text-warm-800/70">
          <LuClock size={16} aria-hidden />
          Pague em até <span className="font-semibold tabular-nums">{formatCountdown(remainingMs)}</span>
        </p>
      )}

      <p className="font-body text-xs text-warm-800/50">
        Assim que o pagamento for confirmado, esta página atualiza sozinha.
      </p>
    </div>
  );
}
