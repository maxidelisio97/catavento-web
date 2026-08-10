/*
 * Bloque divisor angosto entre About e Galeria: rompe o fundo branco
 * continuo que ficaria se ambas secoes fossem adjacentes (mesmo bg-white).
 * No es una seccion de contenido — sin foto, sin grid de 2 columnas, sin
 * texto (evita repetir a frase do Hero). So um separador visual com o
 * icone do catavento, estatico (CataventoIcon nao tem animacao propria).
 */
import { motion, useReducedMotion } from "motion/react";
import { EASE } from "../lib/motion";
import CataventoIcon from "./CataventoIcon";

const ease = EASE;

export default function BrandQuote() {
  const reduce = useReducedMotion();

  return (
    <section className="py-14 md:py-16 bg-sand-50" aria-hidden="true">
      <motion.div
        className="flex items-center justify-center gap-5 max-w-xs mx-auto px-6"
        initial={reduce ? false : { opacity: 0, y: 12 }}
        whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.6, ease }}
      >
        <span className="flex-1 h-px bg-sand-300" />
        <CataventoIcon height={28} className="text-coral-400" />
        <span className="flex-1 h-px bg-sand-300" />
      </motion.div>
    </section>
  );
}
