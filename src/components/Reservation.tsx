"use client";

import { motion, useReducedMotion } from "motion/react";
import { MdWhatsapp, MdPhone, MdStar, MdLocationOn } from "react-icons/md";
import { FaInstagram } from "react-icons/fa";

const WHATSAPP_URL = "https://wa.link/gzgaap";
const WHATSAPP_NUMBER = "5599992325903";
const PHONE_DISPLAY = "+55 99 99232-5903";
const INSTAGRAM_URL = "https://www.instagram.com/pousadacatavento";

const ease = [0.16, 1, 0.3, 1] as const;

const NAV_LINKS = [
  { label: "Início", href: "#hero" },
  { label: "Experiências", href: "#experiencias" },
  { label: "Quartos", href: "#quartos" },
  { label: "Taíba", href: "#taiba" },
  { label: "Galeria", href: "#galeria" },
] as const;

export default function Reservation() {
  const reduce = useReducedMotion();

  return (
    <footer id="reservar" className="relative bg-warm-900 text-white">
      {/* CTA band */}
      <div className="border-b border-white/10">
        <div className="max-w-[1440px] mx-auto px-6 md:px-10 py-16 md:py-20 flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 16 }}
            whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.6, ease }}
          >
            <div className="flex items-center gap-5 mb-5">
              <span className="w-8 h-px bg-white/25" />
              <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-white/45">
                Reserve agora
              </span>
            </div>
            <h2 className="font-heading text-3xl md:text-4xl font-bold text-white uppercase leading-[0.95] tracking-tight max-w-[18ch]">
              Garanta sua estadia em Taíba
            </h2>
          </motion.div>

          <motion.div
            className="flex flex-col sm:flex-row gap-3 shrink-0"
            initial={reduce ? false : { opacity: 0, y: 16 }}
            whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.6, delay: 0.1, ease }}
          >
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 bg-white text-warm-900 hover:bg-sand-100 font-body font-semibold text-[11px] uppercase tracking-[0.12em] px-7 py-3.5 rounded-full transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <MdWhatsapp size={16} className="text-[#25D366]" />
              Reservar pelo WhatsApp
            </a>
            <a
              href="https://www.booking.com/hotel/br/pousada-catavento.html"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 border border-white/25 text-white hover:bg-white/8 font-body font-medium text-[11px] uppercase tracking-[0.12em] px-7 py-3.5 rounded-full transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <MdStar size={14} />
              Booking.com
            </a>
          </motion.div>
        </div>
      </div>

      {/* Footer columns */}
      <div className="max-w-[1440px] mx-auto px-6 md:px-10 py-14 md:py-18 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10 lg:gap-12">
        {/* Brand */}
        <motion.div
          className="sm:col-span-2 lg:col-span-1"
          initial={reduce ? false : { opacity: 0, y: 14 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.5, ease }}
        >
          <a href="#hero" className="flex flex-col leading-none mb-4">
            <span className="font-heading font-bold text-sm tracking-[0.2em] uppercase text-white">
              Catavento
            </span>
            <span className="font-body font-light text-[9px] tracking-[0.3em] uppercase text-white/40 mt-0.5">
              Pousada
            </span>
          </a>
          <p className="font-body text-sm leading-[1.7] text-white/50 max-w-[28ch]">
            Seu refúgio em Taíba. Conforto, natureza e a hospitalidade que você merece.
          </p>
          <a
            href={INSTAGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 mt-6 text-white/40 hover:text-white transition-colors text-sm font-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white rounded"
          >
            <FaInstagram size={16} />
            @pousadacatavento
          </a>
        </motion.div>

        {/* Navigation */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 14 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.5, delay: 0.08, ease }}
        >
          <h4 className="font-body text-[10px] font-semibold uppercase tracking-[0.25em] text-white/40 mb-5">
            Navegação
          </h4>
          <ul className="flex flex-col gap-3">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className="font-body text-sm text-white/60 hover:text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white rounded"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </motion.div>

        {/* Contact */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 14 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.5, delay: 0.16, ease }}
        >
          <h4 className="font-body text-[10px] font-semibold uppercase tracking-[0.25em] text-white/40 mb-5">
            Contato
          </h4>
          <ul className="flex flex-col gap-4">
            <li>
              <a
                href={WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2.5 font-body text-sm text-white/60 hover:text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white rounded"
              >
                <MdWhatsapp size={16} />
                Falar no WhatsApp
              </a>
            </li>
            <li>
              <a
                href={`tel:+${WHATSAPP_NUMBER}`}
                className="inline-flex items-center gap-2.5 font-body text-sm text-white/60 hover:text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white rounded"
              >
                <MdPhone size={15} />
                {PHONE_DISPLAY}
              </a>
            </li>
          </ul>
        </motion.div>

        {/* Address */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 14 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.5, delay: 0.24, ease }}
        >
          <h4 className="font-body text-[10px] font-semibold uppercase tracking-[0.25em] text-white/40 mb-5">
            Localização
          </h4>
          <a
            href="https://www.google.com/maps/search/Pousada+Catavento+Taiba"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-start gap-2.5 font-body text-sm text-white/60 hover:text-white transition-colors leading-[1.6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white rounded"
          >
            <MdLocationOn size={15} className="mt-0.5 shrink-0" />
            R. Francisca Ferreira Martins, 1121<br />
            Taíba — CE, Brasil
          </a>
        </motion.div>
      </div>

      {/* Bottom bar */}
      <motion.div
        className="border-t border-white/8 max-w-[1440px] mx-auto px-6 md:px-10 py-5 flex flex-col sm:flex-row items-center justify-between gap-3 text-[11px] font-body text-white/30"
        initial={reduce ? false : { opacity: 0 }}
        whileInView={reduce ? undefined : { opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, delay: 0.3, ease }}
      >
        <span>&copy; {new Date().getFullYear()} Pousada Catavento. Todos os direitos reservados.</span>
        <span>Taíba, Ceará · Brasil</span>
      </motion.div>
    </footer>
  );
}
