"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { MdWhatsapp } from "react-icons/md";

const WHATSAPP_NUMBER = "5599992325903";
const ease = [0.16, 1, 0.3, 1] as const;

export default function Hero() {
  const reduce = useReducedMotion();
  const [checkin, setCheckin] = useState("");
  const [checkout, setCheckout] = useState("");
  const [guests, setGuests] = useState("2");

  const handleBook = () => {
    const lines = ["Olá! Gostaria de verificar disponibilidade na Pousada Catavento."];
    if (checkin) lines.push(`Check-in: ${checkin}`);
    if (checkout) lines.push(`Check-out: ${checkout}`);
    lines.push(`Hóspedes: ${guests}`);
    const msg = encodeURIComponent(lines.join("\n"));
    window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${msg}`, "_blank");
  };

  return (
    <section id="hero" className="relative min-h-[100dvh] flex flex-col">
      {/* Full-bleed background */}
      <div className="absolute inset-0">
        <img
          src="https://picsum.photos/seed/catavento-hero-wide/1920/1080"
          alt="Vista da Pousada Catavento com jardim e piscina"
          className="w-full h-full object-cover"
          loading="eager"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-warm-900/55 via-warm-900/30 to-warm-900/65" />
      </div>

      {/* Centered hero content */}
      <div className="relative flex-1 flex flex-col items-center justify-center px-6 pt-28 pb-12 text-center">
        <motion.span
          className="font-body text-[10px] font-medium uppercase tracking-[0.35em] text-white/65 mb-8"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1, delay: 0.3 }}
        >
          Pousada · Taíba, Ceará
        </motion.span>

        <motion.h1
          className="font-heading text-[clamp(2.8rem,10vw,7rem)] font-bold text-white uppercase leading-[0.9] tracking-[-0.01em]"
          initial={reduce ? false : { opacity: 0, y: 32 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, delay: 0.45, ease }}
        >
          O verdadeiro
          <br />
          luxo de
          <br />
          <span className="text-coral-400">pés descalços</span>
        </motion.h1>

        <motion.p
          className="mt-7 text-white/70 text-base md:text-lg max-w-[34ch] leading-relaxed"
          initial={reduce ? false : { opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.65, ease }}
        >
          Seu refúgio à beira-mar em Taíba. A 200m da praia, com jardim exuberante, piscina e brisa constante.
        </motion.p>

        <motion.div
          className="mt-9 flex flex-wrap items-center justify-center gap-3"
          initial={reduce ? false : { opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.8, ease }}
        >
          <a
            href={`https://wa.me/${WHATSAPP_NUMBER}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-white text-warm-900 hover:bg-sand-100 font-body font-semibold text-sm px-7 py-3.5 rounded-full transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <MdWhatsapp size={18} className="text-[#25D366]" />
            Reservar via WhatsApp
          </a>
          <a
            href="https://www.booking.com/hotel/br/pousada-catavento.html"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 border border-white/45 text-white hover:bg-white/10 font-body font-medium text-sm px-7 py-3.5 rounded-full transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            Ver avaliações
          </a>
        </motion.div>

        {/* Scroll indicator */}
        <motion.div
          className="mt-14 flex flex-col items-center gap-2 text-white/35"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1.2, delay: 1.2 }}
          aria-hidden
        >
          <span className="font-body text-[9px] uppercase tracking-[0.3em]">Explorar</span>
          <span className="block w-px h-10 bg-white/30 animate-pulse" />
        </motion.div>
      </div>

      {/* Booking bar */}
      <motion.div
        className="relative z-10 bg-white border-t border-sand-200"
        initial={reduce ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 1, ease }}
      >
        <div className="max-w-4xl mx-auto px-6 md:px-10 py-5 flex flex-wrap items-end gap-5">
          <div className="flex-1 min-w-[130px]">
            <label className="block font-body text-[9px] font-semibold uppercase tracking-[0.25em] text-warm-800/50 mb-2">
              Check-in
            </label>
            <input
              type="date"
              value={checkin}
              onChange={(e) => setCheckin(e.target.value)}
              className="w-full font-body text-sm text-warm-900 border-b border-sand-300 pb-1.5 bg-transparent focus:outline-none focus:border-sea-500 transition-colors cursor-pointer"
            />
          </div>

          <span className="hidden sm:block w-px h-8 bg-sand-200" />

          <div className="flex-1 min-w-[130px]">
            <label className="block font-body text-[9px] font-semibold uppercase tracking-[0.25em] text-warm-800/50 mb-2">
              Check-out
            </label>
            <input
              type="date"
              value={checkout}
              onChange={(e) => setCheckout(e.target.value)}
              className="w-full font-body text-sm text-warm-900 border-b border-sand-300 pb-1.5 bg-transparent focus:outline-none focus:border-sea-500 transition-colors cursor-pointer"
            />
          </div>

          <span className="hidden sm:block w-px h-8 bg-sand-200" />

          <div className="min-w-[110px]">
            <label className="block font-body text-[9px] font-semibold uppercase tracking-[0.25em] text-warm-800/50 mb-2">
              Hóspedes
            </label>
            <select
              value={guests}
              onChange={(e) => setGuests(e.target.value)}
              className="w-full font-body text-sm text-warm-900 border-b border-sand-300 pb-1.5 bg-transparent focus:outline-none focus:border-sea-500 transition-colors cursor-pointer"
            >
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? "hóspede" : "hóspedes"}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={handleBook}
            className="flex-none bg-sea-600 hover:bg-sea-500 text-white font-body font-semibold text-[11px] uppercase tracking-[0.12em] px-7 py-3 rounded-lg transition-colors duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sea-500 whitespace-nowrap"
          >
            Verificar disponibilidade
          </button>
        </div>
      </motion.div>
    </section>
  );
}
