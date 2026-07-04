/*
 * Renderiza la galeria filtrable de imagenes del sitio.
 * Aca debo agregar, quitar o categorizar fotos de la galeria.
 * No cambia datos de habitaciones ni informacion de contacto.
 */
import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { cn } from "../lib/utils";
import { EASE } from "../lib/motion";
import { assetPath } from "../config/site";
import RevealImage from "./RevealImage";

const IMAGES = [
  { src: assetPath("images/IMG_6798.webp"), alt: "Piscina da Pousada Catavento", category: "pousada", cols: "md:col-span-2" },
  { src: assetPath("images/triple.webp"), alt: "Quarto aconchegante", category: "pousada", cols: "row-span-2" },
  { src: assetPath("images/IMG_6376.webp"), alt: "Jardim da pousada", category: "pousada", cols: "" },
  { src: assetPath("images/IMG_3224.webp"), alt: "Praia da Taíba", category: "praia", cols: "" },
  { src: assetPath("images/IMG_4051.webp"), alt: "Pôr do sol em Taíba", category: "natureza", cols: "md:col-span-2" },
  { src: assetPath("images/IMG_6611.webp"), alt: "Área de convivência", category: "pousada", cols: "" },
  { src: assetPath("images/IMG_6383.webp"), alt: "Culinária cearense", category: "pousada", cols: "" },
] as const;

const FILTERS = [
  { id: "all", label: "Todas" },
  { id: "pousada", label: "Pousada" },
  { id: "natureza", label: "Natureza" },
  { id: "praia", label: "Praia" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

const ease = EASE;

export default function Gallery() {
  const [filter, setFilter] = useState<FilterId>("all");
  const reduce = useReducedMotion();

  const filtered = filter === "all" ? [...IMAGES] : IMAGES.filter((img) => img.category === filter);

  return (
    <section id="galeria" className="relative py-24 md:py-36 bg-white">
      <div className="max-w-[1440px] mx-auto px-6 md:px-10">
        {/* Section header */}
        <motion.div
          className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-8"
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.6, ease }}
        >
          <div>
            <div className="flex items-center gap-5 mb-5">
              <span className="w-12 h-px bg-sand-300" />
              <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-sea-500">
                Galeria
              </span>
            </div>
            <h2 className="font-heading text-4xl md:text-5xl font-bold text-warm-900 uppercase leading-[0.92] tracking-tight">
              Momentos<br />
              <span className="text-coral-400">Catavento</span>
            </h2>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                aria-pressed={filter === f.id}
                className={cn(
                  "font-body text-[10px] font-semibold uppercase tracking-[0.15em] px-4 py-2 border transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sea-500",
                  filter === f.id
                    ? "bg-warm-900 border-warm-900 text-white"
                    : "border-sand-300 text-warm-800/60 hover:border-warm-900/40 hover:text-warm-900"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </motion.div>

        {/* Grid */}
        <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-3 auto-rows-[220px]">
          <AnimatePresence mode="popLayout">
            {filtered.map((img, i) => (
              <motion.figure
                key={img.src}
                layout
                className={cn("overflow-hidden bg-sand-100", img.cols)}
                initial={reduce ? false : { opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduce ? undefined : { opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.4, delay: 0.03 * i, ease }}
              >
                <RevealImage
                  src={img.src}
                  alt={img.alt}
                  className="w-full h-full object-cover hover:scale-105 transition-transform duration-700"
                  wrapperClassName="h-full"
                  loading="lazy"
                  delay={0.03 * i}
                  amount={0.15}
                />
              </motion.figure>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}
