"use client";

import { motion, useReducedMotion } from "motion/react";

const ease = [0.16, 1, 0.3, 1] as const;

const STATS = [
  { value: "10+", label: "Anos de hospitalidade" },
  { value: "200m", label: "Da praia" },
  { value: "4.8", label: "Avaliação no Booking" },
  { value: "24h", label: "Recepção" },
] as const;

export default function About() {
  const reduce = useReducedMotion();

  return (
    <section className="relative py-24 md:py-36 bg-white overflow-hidden">
      <div className="max-w-[1440px] mx-auto px-6 md:px-10 grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-24 items-center">

        {/* Image column */}
        <motion.div
          className="relative"
          initial={reduce ? false : { opacity: 0, x: -24 }}
          whileInView={reduce ? undefined : { opacity: 1, x: 0 }}
          viewport={{ once: true, amount: 0.25 }}
          transition={{ duration: 0.8, ease }}
        >
          <div className="aspect-[4/5] overflow-hidden rounded-sm">
            <img
              src="https://picsum.photos/seed/catavento-garden/900/1125"
              alt="Jardim e piscina da Pousada Catavento"
              className="w-full h-full object-cover"
              loading="lazy"
            />
          </div>
          {/* Accent block */}
          <div className="absolute -bottom-8 -right-8 w-40 h-40 bg-sand-100 -z-10" />
        </motion.div>

        {/* Text column */}
        <motion.div
          initial={reduce ? false : { opacity: 0, x: 24 }}
          whileInView={reduce ? undefined : { opacity: 1, x: 0 }}
          viewport={{ once: true, amount: 0.25 }}
          transition={{ duration: 0.8, delay: 0.12, ease }}
        >
          {/* Section label */}
          <div className="flex items-center gap-5 mb-8">
            <span className="w-12 h-px bg-sand-300" />
            <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-sea-500">
              A Pousada
            </span>
          </div>

          <h2 className="font-heading text-4xl md:text-5xl font-bold text-warm-900 uppercase leading-[0.92] tracking-tight">
            Um refúgio feito<br />
            <span className="text-sea-500">para você</span>
          </h2>

          <div className="mt-7 space-y-4 font-body text-base leading-[1.75] text-warm-800/65 max-w-[52ch]">
            <p>
              Localizada a poucos passos da Praia da Taíba, a Pousada Catavento
              é o destino ideal para quem busca tranquilidade e contato com a
              natureza. Quartos confortáveis, jardim exuberante e piscina ao ar
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
                <p className="font-heading text-3xl font-bold text-sea-500">{stat.value}</p>
                <p className="font-body text-xs text-warm-800/55 mt-0.5 uppercase tracking-[0.1em]">{stat.label}</p>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
