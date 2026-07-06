/*
 * Bloque divisor angosto entre About y Experiencias: rompe el fondo blanco
 * continuo que quedaria si ambas secciones fueran adyacentes (mismo bg-white).
 * No es una seccion de contenido — sin foto, sin grid de 2 columnas.
 *
 * TODO: el texto de abajo reusa tal cual la linea del hero ("fique como em
 * casa") como marcador visual, no es copy nuevo ni definitivo. Si el dueno
 * prefiere otra frase para este lugar puntual, reemplazar aca.
 */
import { motion, useReducedMotion } from "motion/react";
import { EASE } from "../lib/motion";

const ease = EASE;

export default function BrandQuote() {
  const reduce = useReducedMotion();

  return (
    <section className="py-16 md:py-20 bg-sand-50">
      <motion.p
        className="max-w-[36ch] mx-auto text-center font-heading text-2xl md:text-3xl font-semibold text-warm-900 leading-snug tracking-tight px-6"
        initial={reduce ? false : { opacity: 0, y: 12 }}
        whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.6, ease }}
      >
        Chegue como hóspede,{" "}
        <span className="text-coral-500">fique como em casa</span>.
      </motion.p>
    </section>
  );
}
