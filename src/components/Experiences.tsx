"use client";

import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { MdWaves, MdSpa, MdRestaurant, MdNature } from "react-icons/md";

const EXPERIENCES = [
  {
    id: "kitesurf",
    icon: MdWaves,
    label: "Kitesurf",
    title: "Kitesurf & Esportes Náuticos",
    description:
      "Taíba é um dos melhores destinos de kitesurf do Brasil. Ventos constantes entre 18 e 25 nós, águas calmas e escola de kite a poucos metros da pousada. Iniciante ou experiente — o cenário é perfeito.",
    image: "https://picsum.photos/seed/catavento-kitesurf/1200/900",
  },
  {
    id: "relax",
    icon: MdSpa,
    label: "Relaxamento",
    title: "Paz à Beira da Piscina",
    description:
      "Uma rede na varanda, um livro, a brisa do mar. Nossa piscina e jardim são feitos para quem quer desacelerar de verdade. Sem agenda, sem pressa — só você e o silêncio que a natureza oferece.",
    image: "https://picsum.photos/seed/catavento-pool/1200/900",
  },
  {
    id: "natureza",
    icon: MdNature,
    label: "Natureza",
    title: "Falésias, Coqueirais e Pôr do Sol",
    description:
      "Explore as falésias, trilhas e lagoas ao redor de Taíba. O pôr do sol aqui é um espetáculo — cores que pintam o céu e se refletem no mar em tons de ouro e coral. Imperdível.",
    image: "https://picsum.photos/seed/catavento-sunset/1200/900",
  },
  {
    id: "gastronomia",
    icon: MdRestaurant,
    label: "Gastronomia",
    title: "Sabores do Ceará",
    description:
      "Peixes frescos, lagosta, frutos do mar e a tradicional tapioca nos restaurantes vizinhos. A culinária cearense é um patrimônio à parte — e Taíba tem alguns dos melhores frutos do mar da costa.",
    image: "https://picsum.photos/seed/catavento-food/1200/900",
  },
] as const;

const ease = [0.16, 1, 0.3, 1] as const;

export default function Experiences() {
  const [active, setActive] = useState<string>("kitesurf");
  const reduce = useReducedMotion();

  const current = EXPERIENCES.find((e) => e.id === active) ?? EXPERIENCES[0];

  return (
    <section id="experiencias" className="relative py-24 md:py-36 bg-white overflow-hidden">
      <div className="max-w-[1440px] mx-auto px-6 md:px-10">
        {/* Section header */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease }}
        >
          <div className="flex items-center gap-5 mb-5">
            <span className="w-12 h-px bg-sand-300" />
            <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-sea-500">
              Experiências
            </span>
          </div>
          <h2 className="font-heading text-4xl md:text-5xl font-bold text-warm-900 uppercase leading-[0.92] tracking-tight">
            Viva Taíba<br />
            <span className="text-coral-400">de verdade</span>
          </h2>
        </motion.div>

        {/* Tab selector */}
        <motion.div
          className="mt-10 flex flex-wrap gap-2"
          initial={reduce ? false : { opacity: 0, y: 12 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.1, ease }}
        >
          {EXPERIENCES.map((exp) => (
            <button
              key={exp.id}
              type="button"
              onClick={() => setActive(exp.id)}
              aria-pressed={active === exp.id}
              className={`inline-flex items-center gap-2 px-5 py-2.5 font-body text-[11px] font-semibold uppercase tracking-[0.12em] rounded-full transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sea-500 ${
                active === exp.id
                  ? "bg-warm-900 text-white"
                  : "border border-sand-300 text-warm-800/70 hover:border-warm-900/40 hover:text-warm-900"
              }`}
            >
              <exp.icon size={13} />
              {exp.label}
            </button>
          ))}
        </motion.div>

        {/* Content */}
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start">
          {/* Image */}
          <motion.div
            className="lg:col-span-7"
            initial={reduce ? false : { opacity: 0, y: 20 }}
            whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.15, ease }}
          >
            <div className="relative aspect-[4/3] overflow-hidden bg-sand-100">
              <AnimatePresence mode="wait">
                <motion.img
                  key={current.id}
                  src={current.image}
                  alt={current.title}
                  className="absolute inset-0 w-full h-full object-cover"
                  initial={reduce ? false : { opacity: 0, scale: 1.04 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={reduce ? undefined : { opacity: 0 }}
                  transition={{ duration: 0.5, ease }}
                  loading="lazy"
                />
              </AnimatePresence>
            </div>
          </motion.div>

          {/* Text */}
          <motion.div
            className="lg:col-span-4 lg:col-start-9 lg:sticky lg:top-28"
            initial={reduce ? false : { opacity: 0, y: 20 }}
            whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.25, ease }}
          >
            <AnimatePresence mode="wait">
              <motion.div
                key={current.id}
                initial={reduce ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: -6 }}
                transition={{ duration: 0.3 }}
              >
                <div className="flex items-center gap-3 mb-5">
                  <current.icon size={18} className="text-coral-400" />
                  <span className="w-full h-px bg-sand-200" />
                </div>
                <h3 className="font-heading text-2xl md:text-3xl font-bold text-warm-900 uppercase leading-tight tracking-tight">
                  {current.title}
                </h3>
                <p className="mt-5 font-body text-base leading-[1.75] text-warm-800/65">
                  {current.description}
                </p>
              </motion.div>
            </AnimatePresence>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
