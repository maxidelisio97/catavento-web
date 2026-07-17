/*
 * Construye la primera seccion visible de la homepage.
 * Incluye imagen principal, textos, CTAs y barra de busqueda de reserva.
 * Si necesito cambiar el hero o el formulario inicial, debo editar aca.
 */
import { motion, useReducedMotion } from "motion/react";
import { assetPath } from "../config/site";
import { EASE } from "../lib/motion";
import BookingForm from "./BookingForm";

const ease = EASE;

export default function Hero() {
  const reduce = useReducedMotion();

  return (
    <>
    <section id="hero" className="relative">
      {/* Hero visual block: photo + headline + primary CTA, exactly one viewport tall */}
      <div className="relative min-h-[100dvh] flex flex-col">
        {/* Full-bleed background */}
        <div className="absolute inset-0 bg-sand-300">
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
              className="w-full h-full object-cover"
              loading="eager"
              fetchPriority="high"
              decoding="async"
            />
          </picture>
          <div className="absolute inset-0 bg-gradient-to-b from-warm-900/45 via-warm-900/22 to-warm-900/55" />
          {/* Text-protection scrim: guarantees AA contrast for the headline regardless of what the photo shows underneath */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_85%_70%_at_50%_42%,rgba(15,10,8,0.78),transparent_80%)]" />
        </div>

        {/* Centered hero content */}
        <div className="relative flex-1 flex flex-col items-center justify-center px-6 pt-32 sm:pt-36 pb-10 text-center">
          {/* h1 unico de la pagina: kicker + titulo, cada uno con su propia
              animacion (spans internos), sin wrapper animado propio para que
              el fade de cada linea no se multiplique con el del padre. */}
          <h1 className="flex flex-col items-center">
            <motion.span
              className="font-body text-[10px] font-medium uppercase tracking-[0.35em] text-white/65 mb-6"
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 1, delay: 0.3 }}
            >
              Pousada · Taíba, Ceará
            </motion.span>

            <motion.span
              className="font-heading text-[clamp(2rem,8.5vw,6.5rem)] font-semibold text-white leading-[1.15] tracking-[-0.005em]"
              initial={reduce ? false : { opacity: 0, y: 32 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1, delay: 0.45, ease }}
            >
              Chegue como hóspede,
              <br />
              <span className="text-coral-200">fique como em casa</span>
            </motion.span>
          </h1>

          <motion.p
            className="mt-6 text-white/70 text-base md:text-lg max-w-[34ch] leading-relaxed"
            initial={reduce ? false : { opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, delay: 0.65, ease }}
          >
            Seu refúgio à beira-mar em Taíba. A 100m da praia, com jardim exuberante, piscina e brisa constante.
          </motion.p>

          <motion.div
            className="mt-8 flex flex-wrap items-center justify-center gap-3"
            initial={reduce ? false : { opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, delay: 0.8, ease }}
          >
            <a
              href="#quartos"
              className="inline-flex items-center gap-2 bg-coral-600 hover:bg-coral-500 text-white font-body font-semibold text-sm px-8 py-3.5 rounded-full transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-400"
            >
              Reservar
            </a>
            <a
              href="#experiencias"
              className="inline-flex items-center gap-2 border border-white/45 text-white hover:bg-white/10 font-body font-medium text-sm px-7 py-3.5 rounded-full transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              Conheça a experiência
            </a>
          </motion.div>

          {/* Scroll indicator */}
          <motion.div
            className="mt-10 hidden sm:flex flex-col items-center gap-2 text-white/35"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1.2, delay: 1.2 }}
            aria-hidden
          >
            <span className="font-body text-[9px] uppercase tracking-[0.3em]">Explorar</span>
            <span className="block w-px h-10 bg-white/30 animate-pulse" />
          </motion.div>
        </div>
      </div>
    </section>

    {/* Card de reserva: en desktop se superpone al borde inferior del hero (mitad
        foto, mitad fondo); en mobile va debajo, a ancho completo, sin overlap. */}
    <div id="booking-form" className="relative z-20 scroll-mt-[72px] md:scroll-mt-20 md:px-6 lg:px-10 md:-mt-14 lg:-mt-16">
      <motion.div
        id="booking-form-card"
        className="bg-sand-50 px-6 py-10 md:max-w-4xl md:mx-auto md:rounded-sm md:border md:border-sand-200 md:p-10 md:shadow-xl md:shadow-warm-900/15"
        initial={reduce ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 1, ease }}
      >
        <h2 className="text-center font-heading text-2xl md:text-3xl font-semibold text-warm-900 mb-6 md:mb-8">
          Reserve sua estadia
        </h2>
        <BookingForm />
      </motion.div>
    </div>
    </>
  );
}
