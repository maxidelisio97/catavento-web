/*
 * Muestra depoimentos verificados de hospedes, tal como fueron escritos en Booking.
 * No traducir, no parafrasear, no corregir tipeo: el texto va tal cual la fuente.
 * "(...)" marca recortes ya hechos sobre la resena original.
 *
 * Reserva para uso futuro (no cargar todavia, es para la seccion de experiencias/kite):
 * "If you're a surfer or kitesurfer this is your place. Amazing vibe (surfers and
 * kitesurfers) and very good hosts - overall helpful" — Krisztián, 10
 */
import { motion, useReducedMotion } from "motion/react";
import { MdFormatQuote } from "react-icons/md";
import { EASE } from "../lib/motion";

const FEATURED = {
  quote:
    "Na Pousada Catavento cheguei como hóspede e saí como amigo. Joaquín y Matias são muito receptivos e legais, sempre prontos para ajudar em qualquer situação.",
  name: "Jose Luis, Brasil",
  score: 10,
};

const TESTIMONIALS = [
  {
    quote:
      "From the moment we arrived we felt at home. Maxi & Joaquin were so friendly and inviting they made our stay really special. (...) There is a HUGE kite storage room which was great as we could leave both board bags with all gear safely.",
    name: "Sarah, Reino Unido",
    score: 10,
  },
  {
    quote:
      "La ubicación es perfecta, a 1 cuadra de la playa y del point de surf, al lado del centro de Taiba y de la playa más linda de la zona (...) muchas Gracias por todo Joaquin y Mati, volveríamos denuevo de todas formas.",
    name: "Claudio, Argentina",
    score: 10,
  },
  {
    quote:
      "MARAVILHOSO!! Hospedagem incrível, confortável e localização ótima. Café da manhã maravilhoso, tudo feito com carinho.",
    highlightQuestion: "O que não gostou?",
    highlightAnswer: "Ter q Ir embora ! Adoramos tudo!",
    name: "Andrea, Brasil",
    score: 10,
  },
] as const;

const ease = EASE;

function ScoreBadge({ score }: { score: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      <span className="font-heading text-lg font-semibold text-coral-600">{score}</span>
      <span className="font-body text-[10px] uppercase tracking-[0.1em] text-warm-800/40">Booking</span>
    </span>
  );
}

export default function Testimonials() {
  const reduce = useReducedMotion();

  return (
    <section id="depoimentos" className="relative py-24 md:py-36 bg-sand-50">
      <div className="max-w-[1440px] mx-auto px-6 md:px-10">
        {/* Section header */}
        <motion.div
          className="text-center"
          initial={reduce ? false : { y: 16 }}
          whileInView={reduce ? undefined : { y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.6, ease }}
        >
          <div className="flex items-center justify-center gap-5 mb-5">
            <span className="w-12 h-px bg-sand-300" />
            <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-coral-600">
              Hospitalidade
            </span>
            <span className="w-12 h-px bg-sand-300" />
          </div>
          <h2 className="font-heading text-4xl md:text-5xl font-semibold text-warm-900 leading-[0.98] tracking-tight">
            Quem já ficou, conta
          </h2>
          <p className="mt-4 font-body text-base text-warm-800/55 max-w-[45ch] mx-auto leading-relaxed">
            Depoimentos reais de hóspedes no Booking.com.
          </p>
        </motion.div>

        {/* Featured testimonial */}
        <motion.figure
          className="mt-14 flex flex-col md:flex-row md:items-center gap-6 bg-white p-8 md:p-10 border-l-4 border-coral-500"
          initial={reduce ? false : { y: 16 }}
          whileInView={reduce ? undefined : { y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.6, ease }}
        >
          <MdFormatQuote className="text-coral-500/30 shrink-0" size={44} />
          <div className="flex-1">
            <blockquote className="font-heading text-xl md:text-2xl leading-snug text-warm-900">
              {FEATURED.quote}
            </blockquote>
            <div className="mt-5 flex items-center justify-between gap-4">
              <p className="font-body text-sm font-semibold text-warm-900">{FEATURED.name}</p>
              <ScoreBadge score={FEATURED.score} />
            </div>
          </div>
        </motion.figure>

        {/* Testimonial grid */}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
          {TESTIMONIALS.map((item, i) => (
            <motion.figure
              key={item.name}
              className="flex flex-col bg-white p-8 border border-sand-200"
              initial={reduce ? false : { y: 16 }}
              whileInView={reduce ? undefined : { y: 0 }}
              viewport={{ once: true, amount: 0.15 }}
              transition={{ duration: 0.5, delay: 0.08 + i * 0.08, ease }}
            >
              <MdFormatQuote className="text-coral-500/40" size={32} />

              <blockquote className="mt-3 font-body text-base leading-[1.7] text-warm-800/70 flex-1">
                {item.quote}
              </blockquote>

              {"highlightQuestion" in item && (
                <div className="mt-5 bg-sand-50 px-4 py-3">
                  <p className="font-body text-[10px] font-semibold uppercase tracking-[0.15em] text-warm-800/45">
                    {item.highlightQuestion}
                  </p>
                  <p className="mt-1 font-body text-sm italic text-coral-600">
                    “{item.highlightAnswer}”
                  </p>
                </div>
              )}

              <figcaption className="mt-6 pt-5 border-t border-sand-200 flex items-center justify-between gap-4">
                <p className="font-heading text-base font-semibold text-warm-900">{item.name}</p>
                <ScoreBadge score={item.score} />
              </figcaption>
            </motion.figure>
          ))}
        </div>
      </div>
    </section>
  );
}
