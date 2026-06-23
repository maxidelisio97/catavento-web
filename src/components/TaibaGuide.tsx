"use client";

import { motion, useReducedMotion } from "motion/react";
import { MdWbSunny, MdAir, MdSurfing, MdLocationOn } from "react-icons/md";

const HIGHLIGHTS = [
  {
    icon: MdAir,
    title: "Vento Perfeito",
    description:
      "Ventos constantes entre 18 e 25 nós o ano todo — ideais para kitesurf e windsurf em qualquer nível.",
  },
  {
    icon: MdWbSunny,
    title: "Sol o Ano Inteiro",
    description:
      "Clima tropical com temperaturas médias de 28°C. O sol brilha em Taíba praticamente todos os dias.",
  },
  {
    icon: MdSurfing,
    title: "Praia Paradisíaca",
    description:
      "Coqueirais, falésias e águas mornas. A melhor combinação para dias inesquecíveis à beira-mar.",
  },
  {
    icon: MdLocationOn,
    title: "Acesso Fácil",
    description:
      "A apenas 90 km de Fortaleza, com estrada asfaltada até a pousada. Chegou, relaxou.",
  },
] as const;

const ease = [0.16, 1, 0.3, 1] as const;

export default function TaibaGuide() {
  const reduce = useReducedMotion();

  return (
    <section id="taiba" className="relative py-24 md:py-36 bg-sea-700 overflow-hidden">
      {/* Background texture */}
      <div className="absolute inset-0">
        <img
          src="https://picsum.photos/seed/catavento-taiba-bg/1920/1080"
          alt=""
          className="w-full h-full object-cover opacity-15"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-sea-700/60" />
      </div>

      <div className="relative z-10 max-w-[1440px] mx-auto px-6 md:px-10">
        {/* Section header */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.6, ease }}
        >
          <div className="flex items-center gap-5 mb-5">
            <span className="w-12 h-px bg-white/25" />
            <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-white/55">
              Conheça Taíba
            </span>
          </div>
          <h2 className="font-heading text-4xl md:text-5xl font-bold text-white uppercase leading-[0.92] tracking-tight">
            O paraíso espera<br />
            por você
          </h2>
        </motion.div>

        {/* Highlights grid */}
        <div className="mt-14 grid grid-cols-1 md:grid-cols-2 gap-px bg-white/10">
          {HIGHLIGHTS.map((item, i) => (
            <motion.div
              key={item.title}
              className="flex gap-5 p-8 bg-sea-700/80 hover:bg-sea-600/60 transition-colors duration-300"
              initial={reduce ? false : { opacity: 0, y: 16 }}
              whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.15 }}
              transition={{ duration: 0.5, delay: 0.08 + i * 0.08, ease }}
            >
              <div className="shrink-0 w-10 h-10 flex items-center justify-center border border-white/20">
                <item.icon className="text-white/70" size={18} />
              </div>
              <div>
                <h3 className="font-heading text-base font-bold text-white uppercase tracking-[0.08em]">
                  {item.title}
                </h3>
                <p className="mt-2 font-body text-sm leading-[1.7] text-white/60">
                  {item.description}
                </p>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Location link */}
        <motion.div
          className="mt-10"
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.4, ease }}
        >
          <a
            href="https://www.google.com/maps/search/Pousada+Catavento+Taiba"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 font-body text-sm text-white/50 hover:text-white/80 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white rounded"
          >
            <MdLocationOn size={15} />
            R. Francisca Ferreira Martins, 1121 — Taíba, CE
          </a>
        </motion.div>
      </div>
    </section>
  );
}
