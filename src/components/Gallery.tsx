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
  { src: assetPath("images/dron.webp"), alt: "Vista aérea da pousada, piscina e o mar de Taíba", category: "natureza", cols: "md:col-span-2" },
  { src: assetPath("images/Cuarto Casal/Cuarto-Casal6.webp"), alt: "Suíte Casal", category: "quartos", cols: "row-span-2" },
  { src: assetPath("images/Corredor-Cuarto-Casal.webp"), alt: "Corredor do andar superior com vista para os coqueirais", category: "pousada", cols: "" },
  { src: assetPath("images/estacionamiento.webp"), alt: "Estacionamento da pousada", category: "pousada", cols: "" },
  { src: assetPath("images/Cuarto triplo/Cuarto-triple2.webp"), alt: "Suíte Triplo", category: "quartos", cols: "" },
  { src: assetPath("images/Cuarto Cuadruplo/Cuarto-Cuadruple3.webp"), alt: "Varanda coberta com teto de palha", category: "pousada", cols: "md:col-span-2" },
  { src: assetPath("images/desayuno2.webp"), alt: "Café da manhã servido na pousada", category: "pousada", cols: "" },
] as const;

// Categorias reservadas para fotos que todavia no tenemos (praia, comidas, beco do
// surf, etc.). Se dejan visibles a proposito: cuando lleguen esas fotos, basta con
// agregarlas a IMAGES con la category correspondiente y empiezan a aparecer solas.
const FILTERS = [
  { id: "all", label: "Todas" },
  { id: "pousada", label: "Pousada" },
  { id: "quartos", label: "Quartos" },
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
          initial={reduce ? false : { y: 16 }}
          whileInView={reduce ? undefined : { y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.6, ease }}
        >
          <div>
            <div className="flex items-center gap-5 mb-5">
              <span className="w-12 h-px bg-sand-300" />
              <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-coral-600">
                Galeria
              </span>
            </div>
            <h2 className="font-heading text-4xl md:text-5xl font-semibold text-warm-900 leading-[0.98] tracking-tight">
              Momentos<br />
              <span className="text-coral-500">Catavento</span>
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
                  "font-body text-[10px] font-semibold uppercase tracking-[0.15em] px-4 py-2 border transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-500",
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

        {/* Empty state: categoria reservada sin fotos todavia */}
        {filtered.length === 0 && (
          <motion.p
            className="mt-10 py-16 text-center font-body text-sm text-warm-800/45"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
          >
            Em breve, novas fotos por aqui.
          </motion.p>
        )}

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
