/*
 * Explica los atractivos de Taiba y muestra datos destacados del destino.
 * Aca debo cambiar beneficios, textos turisticos, fondo o enlace al mapa.
 * Es una seccion informativa, no maneja reservas.
 */
import { motion, useReducedMotion } from "motion/react";
import { MdWbSunny, MdAir, MdSurfing, MdLocationOn } from "react-icons/md";
import { assetPath, MAPS_URL } from "../config/site";
import { EASE } from "../lib/motion";

const HIGHLIGHTS = [
  {
    icon: MdAir,
    title: "Vento e Esportes de Prancha",
    description:
      "Taíba é conhecida pelo vento constante que atrai kitesurf, wingsurf e outros esportes de prancha, mantendo a vila conectada ao ritmo do mar.",
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
      "A apenas 70 km de Fortaleza, com estrada asfaltada até a pousada. Chegou, relaxou.",
  },
] as const;

const ease = EASE;

export default function TaibaGuide() {
  const reduce = useReducedMotion();

  return (
    <section id="taiba" className="relative py-24 md:py-36 bg-warm-900 overflow-hidden">
      {/* Background photo */}
      <div className="absolute inset-0">
        <img
          src={assetPath("images/dron.webp")}
          alt=""
          className="w-full h-full object-cover opacity-45"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-warm-900/75 via-warm-900/55 to-warm-900/80" />
      </div>

      <div className="relative z-10 max-w-[1440px] mx-auto px-6 md:px-10">
        {/* Section header */}
        <motion.div
          initial={reduce ? false : { y: 16 }}
          whileInView={reduce ? undefined : { y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.6, ease }}
        >
          <div className="flex items-center gap-5 mb-5">
            <span className="w-12 h-px bg-white/25" />
            <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-white/55">
              Conheça Taíba
            </span>
          </div>
          <h2 className="font-heading text-4xl md:text-5xl font-semibold text-white leading-[0.98] tracking-tight">
            O paraíso espera<br />
            por você
          </h2>
        </motion.div>

        {/* Highlights grid */}
        <div className="mt-14 grid grid-cols-1 md:grid-cols-2 gap-px bg-white/10">
          {HIGHLIGHTS.map((item, i) => (
            <motion.div
              key={item.title}
              className="flex gap-5 p-8 bg-warm-900/70 hover:bg-warm-800/60 transition-colors duration-300"
              initial={reduce ? false : { y: 16 }}
              whileInView={reduce ? undefined : { y: 0 }}
              viewport={{ once: true, amount: 0.15 }}
              transition={{ duration: 0.5, delay: 0.08 + i * 0.08, ease }}
            >
              <div className="shrink-0 w-10 h-10 flex items-center justify-center border border-white/20">
                <item.icon className="text-white/70" size={18} />
              </div>
              <div>
                <h3 className="font-heading text-base font-semibold text-white tracking-[0.01em]">
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
          initial={reduce ? false : { y: 16 }}
          whileInView={reduce ? undefined : { y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.4, ease }}
        >
          <a
            href={MAPS_URL}
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
