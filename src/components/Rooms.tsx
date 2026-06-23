"use client";

import { motion, useReducedMotion } from "motion/react";
import { MdPeople, MdWhatsapp, MdStar } from "react-icons/md";

const WHATSAPP_NUMBER = "5599992325903";

const ROOMS = [
  {
    name: "Suíte Master",
    description: "Quarto espaçoso com cama king-size, varanda com rede e vista para o jardim exuberante.",
    image: "https://picsum.photos/seed/catavento-master/900/1200",
    guests: 2,
    features: ["Ar condicionado", "Wi-Fi", "Frigobar", "Varanda"],
  },
  {
    name: "Quarto Família",
    description: "Ideal para famílias. Duas camas queen, área de estar integrada e espaço generoso.",
    image: "https://picsum.photos/seed/catavento-family/900/1200",
    guests: 4,
    features: ["Ar condicionado", "Wi-Fi", "Cafeteira"],
  },
  {
    name: "Chalé Premium",
    description: "Chalé privativo com ofurô ao ar livre, lounge exclusivo e total privacidade.",
    image: "https://picsum.photos/seed/catavento-chale/900/1200",
    guests: 2,
    features: ["Ofurô", "Ar condicionado", "Wi-Fi", "Frigobar"],
  },
] as const;

const ease = [0.16, 1, 0.3, 1] as const;

function buildWhatsAppUrl(roomName: string) {
  const msg = encodeURIComponent(
    `Olá! Tenho interesse em reservar o(a) ${roomName} na Pousada Catavento. Poderia me informar a disponibilidade?`
  );
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${msg}`;
}

export default function Rooms() {
  const reduce = useReducedMotion();

  return (
    <section id="quartos" className="relative py-24 md:py-36 bg-sand-50">
      <div className="max-w-[1440px] mx-auto px-6 md:px-10">
        {/* Section header */}
        <motion.div
          className="text-center"
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.6, ease }}
        >
          <div className="flex items-center justify-center gap-5 mb-5">
            <span className="w-12 h-px bg-sand-300" />
            <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-sea-500">
              Acomodações
            </span>
            <span className="w-12 h-px bg-sand-300" />
          </div>
          <h2 className="font-heading text-4xl md:text-5xl font-bold text-warm-900 uppercase leading-[0.92] tracking-tight">
            Nossos Quartos
          </h2>
          <p className="mt-4 font-body text-base text-warm-800/55 max-w-[45ch] mx-auto leading-relaxed">
            Conforto e aconchego em cada detalhe, pensados para a melhor estadia.
          </p>
        </motion.div>

        {/* Room cards */}
        <div className="mt-14 grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
          {ROOMS.map((room, i) => (
            <motion.article
              key={room.name}
              className="group flex flex-col bg-white overflow-hidden"
              initial={reduce ? false : { opacity: 0, y: 20 }}
              whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.15 }}
              transition={{ duration: 0.6, delay: 0.1 + i * 0.1, ease }}
            >
              {/* Image */}
              <div className="aspect-[3/4] overflow-hidden">
                <img
                  src={room.image}
                  alt={room.name}
                  className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                  loading="lazy"
                />
              </div>

              {/* Content */}
              <div className="flex flex-col flex-1 p-6 pt-5">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <h3 className="font-heading text-lg font-bold text-warm-900 uppercase tracking-[0.05em]">
                    {room.name}
                  </h3>
                  <span className="flex items-center gap-1 text-xs text-warm-800/45 font-body shrink-0 mt-0.5">
                    <MdPeople size={13} />
                    {room.guests}
                  </span>
                </div>

                <p className="font-body text-sm leading-[1.7] text-warm-800/65 flex-1">
                  {room.description}
                </p>

                <div className="mt-4 flex flex-wrap gap-1.5">
                  {room.features.map((f) => (
                    <span
                      key={f}
                      className="font-body text-[10px] uppercase tracking-[0.1em] text-sea-600 bg-sea-500/8 px-2.5 py-1 rounded-sm"
                    >
                      {f}
                    </span>
                  ))}
                </div>

                {/* Dual CTAs */}
                <div className="mt-6 grid grid-cols-2 gap-2 border-t border-sand-200 pt-5">
                  <a
                    href={buildWhatsAppUrl(room.name)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-1.5 bg-sea-600 hover:bg-sea-500 text-white font-body font-semibold text-[11px] uppercase tracking-[0.1em] py-2.5 rounded transition-colors duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sea-500"
                  >
                    <MdWhatsapp size={14} />
                    Reservar
                  </a>
                  <a
                    href="https://www.booking.com/hotel/br/pousada-catavento.html"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-1.5 border border-sea-600 text-sea-600 hover:bg-sea-600 hover:text-white font-body font-semibold text-[11px] uppercase tracking-[0.1em] py-2.5 rounded transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sea-500"
                  >
                    <MdStar size={13} />
                    Booking
                  </a>
                </div>
              </div>
            </motion.article>
          ))}
        </div>
      </div>
    </section>
  );
}
