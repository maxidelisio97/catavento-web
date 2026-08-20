/*
 * Construye la primera seccion visible de la homepage.
 * Foto de fondo (jardim + catavento + coqueiros) com degrade madera para
 * legibilidade. Sem CTA propio — a reserva pasa por las cards de Quartos.
 */
import { motion, useReducedMotion } from "motion/react";
import { assetPath } from "../config/site";

export default function Hero() {
  const reduce = useReducedMotion();

  return (
    <section id="hero" className="relative bg-madera">
      <div className="relative min-h-[100dvh] flex flex-col">
        {/* Foto de fundo — enquadrada mais para baixo (menos ceu, molino inteiro) */}
        <div className="absolute inset-0 overflow-hidden">
          <picture>
            <source
              type="image/avif"
              srcSet={[640, 828, 1080, 1920]
                .map((w) => `${assetPath(`images/responsive/hero-${w}.avif`)} ${w}w`)
                .join(", ")}
              sizes="100vw"
            />
            <source
              type="image/webp"
              srcSet={[640, 828, 1080, 1920]
                .map((w) => `${assetPath(`images/responsive/hero-${w}.webp`)} ${w}w`)
                .join(", ")}
              sizes="100vw"
            />
            <img
              src={assetPath("images/responsive/hero-1920.webp")}
              alt="Entrada do jardim da Pousada Catavento, com o catavento, pranchas de kite e coqueiros ao fundo"
              className="w-full h-full object-cover object-[center_60%] brightness-105"
              loading="eager"
              fetchPriority="high"
              decoding="async"
            />
          </picture>
          {/* Degrade madera para legibilidade — meio-termo entre a versao
              escura original e a clareada demais. */}
          <div className="absolute inset-0 bg-gradient-to-b from-madera/[0.62] via-madera/20 to-madera/[0.52]" />
          <div className="absolute inset-0 bg-gradient-to-r from-madera/45 to-transparent" />
        </div>

        {/* Conteudo: alinhado ao topo-esquerda */}
        <div className="relative flex-1 flex flex-col justify-center max-w-[1440px] w-full mx-auto px-6 md:px-10 py-24">
          <motion.span
            className="block font-body text-[13px] font-medium uppercase tracking-[0.24em] text-duna3"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1, delay: 0.2 }}
          >
            Pousada Catavento · Taíba, CE
          </motion.span>

          <motion.h1
            className="mt-5 font-heading font-medium text-[clamp(2.5rem,6vw,4.5rem)] leading-[1.05] text-arena max-w-[16ch]"
            initial={reduce ? false : { opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, delay: 0.35 }}
          >
            Seu refúgio na Taíba
          </motion.h1>

          <motion.p
            className="mt-6 font-body text-base md:text-lg text-hero-cream max-w-[44ch] leading-relaxed"
            initial={reduce ? false : { opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, delay: 0.55 }}
          >
            Uma pousada rústica e autêntica, a poucos passos do mar.
          </motion.p>
        </div>
      </div>
    </section>
  );
}
