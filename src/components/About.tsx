/*
 * Presenta la pousada con texto institucional, imagen y estadisticas.
 * Aca debo cambiar la descripcion general o los datos destacados.
 * No controla navegacion ni reservas.
 */
import { motion, useReducedMotion } from "motion/react";
import { assetPath } from "../config/site";
import { EASE } from "../lib/motion";
import RevealImage from "./RevealImage";

const ease = EASE;

const STATS = [
  { value: "3+", label: "Anos de hospitalidade" },
  { value: "100m", label: "Da praia" },
  { value: "8,8", label: "Avaliação no Booking" },
  { value: "XL", label: "Guarda-kites" },
] as const;

export default function About() {
  const reduce = useReducedMotion();

  return (
    <section className="relative py-24 md:py-36 bg-white overflow-hidden">
      <div className="max-w-[1440px] mx-auto px-6 md:px-10 grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-24 items-center">

        {/* Image column */}
        <motion.div
          className="relative min-w-0"
          initial={reduce ? false : { x: -24 }}
          whileInView={reduce ? undefined : { x: 0 }}
          viewport={{ once: true, amount: 0.25 }}
          transition={{ duration: 0.8, ease }}
        >
          <RevealImage
            src={assetPath("images/Entrada-parque.webp")}
            alt="Corredor coberto e jardim da Pousada Catavento"
            className="w-full h-full object-cover"
            wrapperClassName="aspect-[4/5] rounded-sm"
            loading="lazy"
            amount={0.25}
          />
          {/* Accent block */}
          <div className="absolute -bottom-8 -right-8 w-40 h-40 bg-sand-100 -z-10" />
        </motion.div>

        {/* Text column */}
        <motion.div
          initial={reduce ? false : { x: 24 }}
          whileInView={reduce ? undefined : { x: 0 }}
          viewport={{ once: true, amount: 0.25 }}
          transition={{ duration: 0.8, delay: 0.12, ease }}
        >
          {/* Section label */}
          <div className="flex items-center gap-5 mb-8">
            <span className="w-12 h-px bg-sand-300" />
            <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-coral-600">
              A Pousada
            </span>
          </div>

          <h2 className="font-heading text-4xl md:text-5xl font-semibold text-warm-900 leading-[0.98] tracking-tight">
            Um refúgio feito<br />
            <span className="text-coral-500">para você</span>
          </h2>

          <div className="mt-7 space-y-4 font-body text-base leading-[1.75] text-warm-800/65 max-w-[52ch]">
            <p>
              Localizada a poucos passos da Praia da Taibinha, a Pousada Catavento
              é o destino ideal para quem busca tranquilidade e contato com a
              natureza. Quartos confortáveis, jardim e piscina ao ar
              livre — tudo pensado para sua melhor estadia.
            </p>
            <p>
              Aqui o vento sopra a seu favor. Perfeito para casais, famílias e
              aventureiros que querem explorar a força do vento, o calor do sol
              e a paz do mar.
            </p>
          </div>

          {/* Stats */}
          <div className="mt-10 grid grid-cols-2 gap-x-10 gap-y-6 border-t border-sand-200 pt-8">
            {STATS.map((stat) => (
              <div key={stat.label}>
                <p className="font-heading text-3xl font-semibold text-coral-600">{stat.value}</p>
                <p className="font-body text-xs text-warm-800/55 mt-0.5 uppercase tracking-[0.1em]">{stat.label}</p>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
