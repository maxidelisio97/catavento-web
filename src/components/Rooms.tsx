/*
 * Renderiza la seccion de habitaciones y sus tarjetas.
 * Aca debo cambiar nombres, descripciones, imagenes y amenities de cuartos.
 * Tambien arma el enlace de reserva por WhatsApp para cada habitacion.
 */
import { motion, useReducedMotion } from "motion/react";
import {
  MdPeople,
  MdAcUnit,
  MdWifi,
  MdShower,
  MdSquareFoot,
  MdKingBed,
  MdSingleBed,
} from "react-icons/md";
import { PiFanFill } from "react-icons/pi";
import { assetPath, buildHqbedsUrl } from "../config/site";
import { EASE } from "../lib/motion";
import Carousel from "./Carousel";

const AMENITIES = [
  { icon: MdAcUnit, label: "Ar-condicionado" },
  { icon: PiFanFill, label: "Ventilador de teto" },
  { icon: MdWifi, label: "Wi-Fi gratuito" },
  { icon: MdShower, label: "Banheiro privativo com água quente" },
] as const;

const ROOMS = [
  {
    name: "Suíte Casal",
    description:
      "Suíte para até 2 pessoas, equipada com 1 cama de casal. Ideal para casais ou viajantes individuais que buscam conforto e tranquilidade em Taíba.",
    images: [
      { src: assetPath("images/Cuarto Casal/Cuarto-Casal6.webp"), alt: "Suíte Casal — cama e varanda" },
      { src: assetPath("images/Cuarto Casal/Cuarto-Casal8.webp"), alt: "Suíte Casal — cama com vista para a varanda" },
      { src: assetPath("images/Cuarto Casal/Cuarto-Casal2.webp"), alt: "Suíte Casal — banheiro privativo" },
    ],
    guests: 2,
    area: 15,
    priceWeekday: 180,
    priceWeekend: 220,
    beds: [{ icon: MdKingBed, count: 1, label: "Cama de casal" }],
  },
  {
    name: "Suíte Triplo",
    description:
      "Acomodação para até 3 pessoas, com 1 cama de casal e 1 cama de solteiro. Ideal para casais, pequenas famílias ou amigos.",
    images: [
      { src: assetPath("images/Cuarto triplo/Cuarto-triple2.webp"), alt: "Suíte Triplo — camas e ventilador de teto" },
      { src: assetPath("images/Cuarto triplo/Cuarto-triple5.webp"), alt: "Suíte Triplo — cama de casal e cama de solteiro" },
      { src: assetPath("images/Cuarto triplo/Cuarto-triple3.webp"), alt: "Suíte Triplo — banheiro privativo" },
      { src: assetPath("images/Cuarto triplo/Cuarto-triple6.webp"), alt: "Suíte Triplo — varanda com rede" },
    ],
    guests: 3,
    area: 20,
    priceWeekday: 240,
    priceWeekend: 280,
    beds: [
      { icon: MdKingBed, count: 1, label: "Cama de casal" },
      { icon: MdSingleBed, count: 1, label: "Cama de solteiro" },
    ],
  },
  {
    name: "Suíte Quádruplo",
    description:
      "Acomodação para até 4 pessoas, com 1 cama de casal e 2 camas de solteiro. Ideal para famílias, grupos de amigos ou viajantes.",
    images: [
      { src: assetPath("images/Cuarto Cuadruplo/Cuarto-Cuadruple1.webp"), alt: "Suíte Quádruplo — camas" },
      { src: assetPath("images/Cuarto Cuadruplo/Cuarto-Cuadruple2.webp"), alt: "Suíte Quádruplo — banheiro privativo" },
    ],
    guests: 4,
    area: 25,
    priceWeekday: 280,
    priceWeekend: 320,
    beds: [
      { icon: MdKingBed, count: 1, label: "Cama de casal" },
      { icon: MdSingleBed, count: 2, label: "Camas de solteiro" },
    ],
  },
] as const;

// Precos de referencia (tarifa padrao, com cafe da manha) tal como no motor HQBeds.
// Sujeitos a variacao por temporada — o valor real e sempre validado no motor ao reservar.

const ease = EASE;

export default function Rooms() {
  const reduce = useReducedMotion();

  return (
    <section id="quartos" className="relative py-24 md:py-36 bg-sand-50">
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
              Acomodações
            </span>
            <span className="w-12 h-px bg-sand-300" />
          </div>
          <h2 className="font-heading text-4xl md:text-5xl font-semibold text-warm-900 leading-[0.98] tracking-tight">
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
              initial={reduce ? false : { y: 20 }}
              whileInView={reduce ? undefined : { y: 0 }}
              viewport={{ once: true, amount: 0.15 }}
              transition={{ duration: 0.6, delay: 0.1 + i * 0.1, ease }}
            >
              {/* Image carousel */}
              <Carousel
                images={room.images}
                className="w-full h-full object-cover"
                wrapperClassName="aspect-[3/4]"
                delay={0.12 + i * 0.08}
                amount={0.15}
              />

              {/* Content */}
              <div className="flex flex-col flex-1 p-6 pt-5">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <h3 className="font-heading text-lg font-semibold text-warm-900 tracking-[0.01em]">
                    {room.name}
                  </h3>
                  <span className="flex items-center gap-2.5 text-warm-800/45 shrink-0 mt-0.5">
                    <span className="flex items-center gap-1 text-xs font-body" aria-label={`${room.area} metros quadrados`}>
                      <MdSquareFoot size={13} />
                      {room.area}m²
                    </span>
                    <span className="flex items-center gap-1 text-xs font-body" aria-label={`Até ${room.guests} pessoas`}>
                      <MdPeople size={13} />
                      {room.guests}
                    </span>
                  </span>
                </div>

                <p className="font-body text-sm leading-[1.7] text-warm-800/65 flex-1">
                  {room.description}
                </p>

                {/* Beds */}
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  {room.beds.map((bed) => (
                    <span
                      key={bed.label}
                      className="flex items-center gap-1.5 text-warm-800/60"
                      aria-label={`${bed.count} ${bed.label}`}
                    >
                      <bed.icon size={18} className="text-coral-600" />
                      <span className="font-body text-xs">
                        {bed.count > 1 ? `${bed.count}×` : ""} {bed.label}
                      </span>
                    </span>
                  ))}
                </div>

                {/* Amenities */}
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 border-t border-sand-200 pt-4">
                  {AMENITIES.map((a) => (
                    <span
                      key={a.label}
                      className="flex items-center gap-1.5 text-stone-500"
                      title={a.label}
                      aria-label={a.label}
                    >
                      <a.icon size={16} />
                    </span>
                  ))}
                </div>

                {/* Preço de referência — validado sempre no motor ao reservar */}
                <div className="mt-4 flex items-end justify-between gap-3 border-t border-sand-200 pt-4">
                  <div>
                    <span className="font-heading text-2xl font-semibold text-coral-600">
                      R$ {room.priceWeekday}
                    </span>
                    <span className="font-body text-xs text-warm-800/50"> /noite</span>
                    <p className="font-body text-[10px] text-warm-800/45 mt-0.5">
                      Sex e sáb: R$ {room.priceWeekend}
                    </p>
                  </div>
                  <span className="font-body text-[10px] text-warm-800/45 text-right leading-tight">
                    Café da manhã
                    <br />
                    incluído
                  </span>
                </div>

                {/* CTA — motor de reservas real (HQBeds). adults = capacidade do quarto,
                    para que apareça primeiro no listado (nao ha deep-link por quarto). */}
                <div className="mt-4">
                  <a
                    href={buildHqbedsUrl({ adults: room.guests })}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center bg-coral-600 hover:bg-coral-500 text-white font-body font-semibold text-[11px] uppercase tracking-[0.1em] py-2.5 rounded transition-colors duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-500"
                  >
                    Reservar
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
