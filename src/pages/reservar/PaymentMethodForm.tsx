/*
 * Sub-passo do ConfirmationStep (modulo 4): escolha de metodo de pagamento
 * (PIX ou cartao) + CPF/CNPJ do titular, exigido pelo backend antes de criar
 * o cobranca no Asaas. Mesmo padrao de validacao/erro do GuestDataStep.
 */
import { useState } from "react";
import { LuCircleAlert } from "react-icons/lu";

interface PaymentMethodFormProps {
  depositLabel: string;
  submitting: boolean;
  errorMessage: string | null;
  onSubmit: (method: "pix" | "card", cpfCnpj: string) => void;
}

export default function PaymentMethodForm({
  depositLabel,
  submitting,
  errorMessage,
  onSubmit,
}: PaymentMethodFormProps) {
  const [method, setMethod] = useState<"pix" | "card">("pix");
  const [cpf, setCpf] = useState("");
  const [cpfError, setCpfError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const digits = cpf.replace(/\D/g, "");
    if (digits.length < 11) {
      setCpfError("Digite um CPF ou CNPJ válido.");
      return;
    }
    setCpfError(null);
    onSubmit(method, digits);
  }

  function optionClass(active: boolean) {
    return `flex-1 rounded-xl border px-4 py-3 font-body text-sm font-semibold transition-colors ${
      active
        ? "border-coral-500 bg-coral-50 text-coral-700"
        : "border-stone-300 bg-white text-warm-800/70 hover:border-stone-400"
    }`;
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-2xl border border-stone-300 bg-white p-5 space-y-4 text-left">
      <p className="font-body text-sm text-warm-800/70">
        Para garantir seu quarto, pague o depósito de{" "}
        <span className="font-semibold text-warm-900">{depositLabel}</span> agora. O restante você paga direto na
        pousada.
      </p>

      <div className="flex gap-2" role="radiogroup" aria-label="Forma de pagamento">
        <button
          type="button"
          role="radio"
          aria-checked={method === "pix"}
          onClick={() => setMethod("pix")}
          className={optionClass(method === "pix")}
        >
          PIX
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={method === "card"}
          onClick={() => setMethod("card")}
          className={optionClass(method === "card")}
        >
          Cartão
        </button>
      </div>

      <div>
        <label
          htmlFor="payment-cpf"
          className="block font-body text-xs font-semibold uppercase tracking-[0.1em] text-warm-800/60 mb-1.5"
        >
          CPF ou CNPJ do titular
        </label>
        <input
          id="payment-cpf"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={cpf}
          onChange={(e) => setCpf(e.target.value)}
          placeholder="000.000.000-00"
          aria-invalid={Boolean(cpfError)}
          className="w-full rounded-xl border border-stone-300 bg-white px-4 py-3 font-body text-sm text-warm-900 placeholder:text-warm-800/35 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-400"
        />
        {cpfError && (
          <p role="alert" className="mt-1.5 flex items-start gap-1.5 font-body text-xs text-coral-600">
            <LuCircleAlert size={13} className="shrink-0 mt-0.5" />
            <span>{cpfError}</span>
          </p>
        )}
      </div>

      {errorMessage && (
        <p role="alert" className="flex items-start gap-1.5 font-body text-sm text-coral-600">
          <LuCircleAlert size={16} className="shrink-0 mt-0.5" />
          <span>{errorMessage}</span>
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full h-14 rounded-2xl bg-coral-600 hover:bg-coral-500 text-white font-body font-semibold transition-colors active:scale-[0.98] disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-400"
      >
        {submitting ? "Processando…" : method === "pix" ? "Gerar QR Code PIX" : "Pagar com cartão"}
      </button>
    </form>
  );
}
