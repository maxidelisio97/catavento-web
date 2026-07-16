/*
 * Seccion de contacto B2B (agencias, escolas de kite, organizadores de
 * grupos) — embudo separado del BookingForm principal, pensado para
 * consultas que se coordinan manualmente, no autoreserva.
 * Envia via Formspree (FORMSPREE_FORM_ID en config/site.ts), sin backend
 * propio. El <form> usa action/method nativos como fallback progresivo:
 * funciona igual si JS falla, el fetch en onSubmit solo mejora la UX
 * (modal de exito en vez de la redireccion default de Formspree).
 */
import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { MdCheckCircle, MdClose } from "react-icons/md";
import { FORMSPREE_FORM_ID, WHATSAPP_URL } from "../config/site";
import { EASE } from "../lib/motion";

const ease = EASE;

const INQUIRY_TYPES = [
  "Agência de viagens",
  "Organizador de kitetrips",
  "Grupo grande",
  "Outro",
] as const;

type Status = "idle" | "sending" | "success" | "error";

const inputClass =
  "w-full rounded-lg border border-stone-300 bg-white px-4 py-2.5 font-body text-sm text-warm-900 placeholder:text-warm-800/35 focus:outline-none focus:ring-2 focus:ring-coral-500/40 focus:border-coral-500 transition-colors";
const labelClass = "block font-body text-xs font-semibold uppercase tracking-[0.08em] text-warm-800/60 mb-1.5";

export default function Partnerships() {
  const reduce = useReducedMotion();
  const [status, setStatus] = useState<Status>("idle");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setStatus("sending");

    try {
      const res = await fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        setStatus("success");
        form.reset();
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  return (
    <section id="parcerias" className="relative py-24 md:py-36 bg-sand-50 scroll-mt-[72px] md:scroll-mt-20">
      <div className="max-w-[1440px] mx-auto px-6 md:px-10">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 lg:gap-20">
          {/* Texto */}
          <motion.div
            initial={reduce ? false : { y: 16 }}
            whileInView={reduce ? undefined : { y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.6, ease }}
          >
            <div className="flex items-center gap-5 mb-5">
              <span className="w-12 h-px bg-sand-300" />
              <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-coral-600">
                Parcerias
              </span>
            </div>
            <h2 className="font-heading text-4xl md:text-5xl font-semibold text-warm-900 leading-[0.98] tracking-tight">
              Trabalha com grupos ou viagens?
            </h2>
            <p className="mt-5 font-body text-base text-warm-800/60 max-w-[45ch] leading-relaxed">
              Trabalhamos com agências de viagem, escolas de kitesurf e
              organizadores de grupos grandes. Conta pra gente os detalhes e
              coordenamos a estadia juntos.
            </p>
          </motion.div>

          {/* Formulario */}
          <motion.form
            action={`https://formspree.io/f/${FORMSPREE_FORM_ID}`}
            method="POST"
            onSubmit={handleSubmit}
            className="flex flex-col gap-4"
            initial={reduce ? false : { y: 16 }}
            whileInView={reduce ? undefined : { y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.6, delay: 0.1, ease }}
          >
            <div>
              <label htmlFor="partner-name" className={labelClass}>
                Nome / Empresa
              </label>
              <input id="partner-name" name="name" type="text" required className={inputClass} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="partner-email" className={labelClass}>
                  Email
                </label>
                <input id="partner-email" name="email" type="email" required className={inputClass} />
              </div>
              <div>
                <label htmlFor="partner-phone" className={labelClass}>
                  Telefone / WhatsApp
                </label>
                <input id="partner-phone" name="phone" type="tel" required className={inputClass} />
              </div>
            </div>

            <div>
              <label htmlFor="partner-type" className={labelClass}>
                Tipo de consulta
              </label>
              <select id="partner-type" name="inquiry_type" required defaultValue="" className={inputClass}>
                <option value="" disabled>
                  Selecione uma opção
                </option>
                {INQUIRY_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="partner-message" className={labelClass}>
                Mensagem
              </label>
              <textarea
                id="partner-message"
                name="message"
                required
                rows={4}
                placeholder="Tamanho do grupo, datas tentativas, detalhes..."
                className={inputClass}
              />
            </div>

            <button
              type="submit"
              disabled={status === "sending"}
              className="mt-2 self-start bg-coral-600 hover:bg-coral-500 text-white font-body font-semibold text-[11px] uppercase tracking-[0.12em] px-7 py-3.5 rounded-full transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-500 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {status === "sending" ? "Enviando..." : "Enviar consulta"}
            </button>

            {status === "error" && (
              <p role="alert" className="font-body text-sm text-coral-600">
                Não foi possível enviar sua mensagem. Tente novamente ou{" "}
                <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="underline font-semibold">
                  fale pelo WhatsApp
                </a>
                .
              </p>
            )}
          </motion.form>
        </div>
      </div>

      {/* Modal de sucesso */}
      <AnimatePresence>
        {status === "success" && (
          <>
            <motion.div
              aria-hidden="true"
              className="fixed inset-0 z-[70] bg-warm-900/50"
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduce ? undefined : { opacity: 0 }}
              transition={{ duration: 0.25 }}
              onClick={() => setStatus("idle")}
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="Consulta enviada"
              className="fixed inset-0 z-[71] flex items-center justify-center px-6"
              initial={reduce ? false : { opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? undefined : { opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.25 }}
            >
              <div className="relative w-full max-w-sm bg-white rounded-2xl p-8 text-center shadow-xl shadow-warm-900/25">
                <button
                  type="button"
                  onClick={() => setStatus("idle")}
                  aria-label="Fechar"
                  className="absolute top-3 right-3 p-1.5 rounded-full text-warm-800/40 hover:text-warm-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-500"
                >
                  <MdClose size={18} />
                </button>
                <MdCheckCircle className="mx-auto text-coral-600" size={40} />
                <h3 className="mt-4 font-heading text-xl font-semibold text-warm-900">Obrigado!</h3>
                <p className="mt-2 font-body text-sm text-warm-800/60">
                  Em breve entraremos em contato.
                </p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </section>
  );
}
