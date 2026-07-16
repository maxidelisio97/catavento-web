/*
 * Renderiza la galeria filtrable de imagenes del sitio.
 * Aca debo agregar, quitar o categorizar fotos de la galeria.
 * No cambia datos de habitaciones ni informacion de contacto.
 */
import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "../lib/utils";
import { EASE } from "../lib/motion";
import { assetPath } from "../config/site";
import Carousel from "./Carousel";

const IMAGES = [
  { src: assetPath("images/dron.webp"), alt: "Vista aérea da pousada, piscina e o mar de Taíba", category: "natureza" },
  { src: assetPath("images/Cuarto Casal/Cuarto-Casal6.webp"), alt: "Suíte Casal", category: "quartos" },
  { src: assetPath("images/Corredor-Cuarto-Casal.webp"), alt: "Corredor do andar superior com vista para os coqueirais", category: "pousada" },
  { src: assetPath("images/estacionamiento.webp"), alt: "Estacionamento da pousada", category: "pousada" },
  { src: assetPath("images/Cuarto triplo/Cuarto-triple2.webp"), alt: "Suíte Triplo", category: "quartos" },
  { src: assetPath("images/Cuarto Cuadruplo/Cuarto-Cuadruple3.webp"), alt: "Varanda coberta com teto de palha", category: "pousada" },
  { src: assetPath("images/desayuno2.webp"), alt: "Café da manhã servido na pousada", category: "pousada" },
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
          initial={reduce ? false : { y: 16 }}
          whileInView={reduce ? undefined : { y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.6, ease }}
        >
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
        </motion.div>

        {/* Filters */}
        <motion.div
          className="mt-10 flex flex-wrap gap-2"
          initial={reduce ? false : { y: 12 }}
          whileInView={reduce ? undefined : { y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5, delay: 0.1, ease }}
        >
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

        {/* Carrossel + texto, mesmo padrao de grid de About.tsx/Experiences.tsx */}
        {filtered.length > 0 && (
          <div className="mt-8 grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start">
            {/* Carrossel — a key com o filtro forca reinicio no indice 0 ao
                trocar de categoria, em vez de manter um indice que pode
                ficar fora do alcance do novo array filtrado. */}
            <motion.div
              className="lg:col-span-7 min-w-0"
              initial={reduce ? false : { y: 20 }}
              whileInView={reduce ? undefined : { y: 0 }}
              viewport={{ once: true, amount: 0.15 }}
              transition={{ duration: 0.6, delay: 0.15, ease }}
            >
              <Carousel
                key={filter}
                images={filtered}
                className="w-full h-full object-cover"
                wrapperClassName="aspect-[4/3] bg-sand-100"
                amount={0.1}
              />
            </motion.div>

            {/* Texto */}
            <motion.div
              className="lg:col-span-4 lg:col-start-9 lg:sticky lg:top-28"
              initial={reduce ? false : { y: 20 }}
              whileInView={reduce ? undefined : { y: 0 }}
              viewport={{ once: true, amount: 0.15 }}
              transition={{ duration: 0.6, delay: 0.25, ease }}
            >
              <h3 className="font-heading text-2xl md:text-3xl font-semibold text-warm-900 leading-tight tracking-tight">
                Cada foto, um pouco do nosso dia a dia
              </h3>
              <p className="mt-5 font-body text-base leading-[1.75] text-warm-800/65">
                O vento que balança o catavento, os quartos aconchegantes, o
                jardim e a piscina, o café da manhã compartilhado — os
                registros aqui são momentos reais de quem já passou pela
                pousada.
              </p>
            </motion.div>
          </div>
        )}
      </div>
    </section>
  );
}
