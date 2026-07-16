/*
 * Renderiza la seccion de habitaciones y sus tarjetas.
 * Aca debo cambiar nombres, descripciones, imagenes y amenities de cuartos.
 * Tambien arma el enlace de reserva por WhatsApp para cada habitacion.
 */
import { motion, useReducedMotion } from "motion/react";
import type { IconType } from "react-icons";
import {
  MdPeople,
  MdAcUnit,
  MdWifi,
  MdShower,
  MdSquareFoot,
  MdKingBed,
  MdSingleBed,
  MdChildFriendly,
  MdPets,
  MdCheck,
  MdClose,
  MdFreeBreakfast,
} from "react-icons/md";
import { PiFanFill, PiTowel } from "react-icons/pi";
import { assetPath, buildHqbedsUrl } from "../config/site";
import { EASE } from "../lib/motion";
import { useBookingDates } from "../lib/bookingDates";
import { toIsoDate } from "../lib/dates";
import { goToBookingForm } from "../lib/scroll";
import { useToast } from "../lib/toast";
import Carousel from "./Carousel";

const AMENITIES = [
  { icon: MdAcUnit, label: "Ar-condicionado" },
  { icon: PiFanFill, label: "Ventilador de teto" },
  { icon: MdWifi, label: "Wi-Fi gratuito" },
  { icon: MdShower, label: "Banheiro privativo com água quente" },
  { icon: PiTowel, label: "Roupa de cama e toalhas" },
] as const;

const ROOMS = [
  {
    name: "Suíte Casal",
    description: "Ideal para casais ou viajantes individuais.",
    images: [
      { src: assetPath("images/Cuarto Casal/Cuarto-Casal6.webp"), alt: "Suíte Casal — cama de casal com ventilador de teto e vista para a varanda" },
      { src: assetPath("images/Cuarto Casal/Cuarto-Casal8.webp"), alt: "Suíte Casal — cama de casal com toalhas e estante" },
      { src: assetPath("images/Cuarto Casal/Cuarto-Casal1.webp"), alt: "Suíte Casal — cama de casal com cabeceira de madeira" },
      { src: assetPath("images/Cuarto Casal/Cuarto-Casal7.webp"), alt: "Suíte Casal — varanda com porta de vidro e estante" },
      {
        src: assetPath("images/Cuarto Casal/Cuarto-Casal3.webp"),
        alt: "Suíte Casal — cantinho de trabalho com mesa e cadeira",
        // Foto original e um retrato alto (2:3) forcado num wrapper 4/3, que so
        // mostra 50% da altura. "center bottom" cortava a mesa e a cadeira pelos
        // pes sem chao; "center 65%" e o ponto que mantem mesa+livros e a
        // cadeira inteira dentro do crop.
        position: "center 65%",
      },
      { src: assetPath("images/Cuarto Casal/Cuarto-Casal2.webp"), alt: "Suíte Casal — banheiro com pias em pedra e espelhos" },
      {
        src: assetPath("images/Cuarto Casal/Cuarto-Casal4.webp"),
        alt: "Suíte Casal — banheiro com vaso sanitário e box",
        // Mesmo caso: retrato 2:3 no wrapper 4/3. Centro cortava a base do vaso
        // sanitario; ancorando embaixo mostra o vaso inteiro com o piso.
        position: "center bottom",
      },
      { src: assetPath("images/Cuarto Casal/Cuarto-Casal5.webp"), alt: "Suíte Casal — entrada do quarto e varanda com rede" },
    ],
    guests: 2,
    area: 15,
    beds: [{ icon: MdKingBed, count: 1, label: "Cama de casal" }],
    allowsChildren: false,
    allowsPets: false,
  },
  {
    name: "Suíte Triplo",
    description: "Ideal para casais, pequenas famílias ou amigos.",
    images: [
      { src: assetPath("images/Cuarto triplo/Cuarto-triple2.webp"), alt: "Suíte Triplo — camas e ventilador de teto" },
      { src: assetPath("images/Cuarto triplo/Cuarto-triple5.webp"), alt: "Suíte Triplo — cama de casal e cama de solteiro" },
      { src: assetPath("images/Cuarto triplo/Cuarto-triple1.webp"), alt: "Suíte Triplo — banheiro com pia moderna e box" },
      { src: assetPath("images/Cuarto triplo/Cuarto-triple3.webp"), alt: "Suíte Triplo — pia do banheiro com amenities" },
      { src: assetPath("images/Cuarto triplo/Cuarto-triple6.webp"), alt: "Suíte Triplo — varanda com rede, mesa e cadeiras" },
      { src: assetPath("images/Cuarto triplo/Cuarto-triple4.webp"), alt: "Suíte Triplo — corredor externo com teto de palha" },
    ],
    guests: 3,
    area: 25,
    beds: [
      { icon: MdKingBed, count: 1, label: "Cama de casal" },
      { icon: MdSingleBed, count: 1, label: "Cama de solteiro" },
    ],
    allowsChildren: true,
    allowsPets: true,
  },
  {
    name: "Suíte Quádruplo",
    description: "Ideal para famílias, grupos de amigos ou viajantes.",
    images: [
      { src: assetPath("images/Cuarto Cuadruplo/Cuarto-Cuadruple1.webp"), alt: "Suíte Quádruplo — camas com roupa de cama azul-marinho" },
      { src: assetPath("images/Cuarto Cuadruplo/Cuarto-Cuadruple2.webp"), alt: "Suíte Quádruplo — banheiro com vaso sanitário e pia" },
      { src: assetPath("images/Cuarto Cuadruplo/Cuarto-Cuadruple3.webp"), alt: "Suíte Quádruplo — varanda coberta com teto de palha" },
      { src: assetPath("images/Cuarto Cuadruplo/Cuarto-Cuadruple4.webp"), alt: "Suíte Quádruplo — fachada externa com teto de palha e coqueiros" },
    ],
    guests: 4,
    area: 30,
    beds: [
      { icon: MdKingBed, count: 1, label: "Cama de casal" },
      { icon: MdSingleBed, count: 2, label: "Camas de solteiro" },
    ],
    allowsChildren: true,
    allowsPets: true,
  },
] as const;

const ease = EASE;

type PolicyBadgeProps = { icon: IconType; allowed: boolean; label: string };

function PolicyBadge({ icon: Icon, allowed, label }: PolicyBadgeProps) {
  return (
    <span
      className="flex items-center gap-1 rounded-full border border-stone-300 px-2 py-0.5 text-stone-500"
      title={`${label}: ${allowed ? "permitido" : "não permitido"}`}
      aria-label={`${label}: ${allowed ? "permitido" : "não permitido"}`}
    >
      <Icon size={13} />
      {allowed ? <MdCheck size={12} className="text-coral-600" /> : <MdClose size={12} className="text-stone-400" />}
    </span>
  );
}

export default function Rooms() {
  const reduce = useReducedMotion();
  const { range } = useBookingDates();
  const toast = useToast();

  // Se o usuario ja escolheu datas completas no BookingForm, leva elas
  // junto ao ir para o HQBeds — em vez de mandar sem datas, so com a
  // capacidade maxima do quarto (comportamento antigo, mantido como
  // fallback quando ainda nao ha datas selecionadas).
  const hasCompleteRange = Boolean(range?.from && range?.to && range.to.getTime() !== range.from.getTime());

  function buildRoomUrl(guests: number) {
    if (hasCompleteRange) {
      return buildHqbedsUrl({
        arrival: toIsoDate(range!.from!),
        departure: toIsoDate(range!.to!),
        adults: guests,
      });
    }
    return buildHqbedsUrl({ adults: guests });
  }

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
                wrapperClassName="aspect-[4/3]"
                delay={0.12 + i * 0.08}
                amount={0.15}
              />

              {/* Content */}
              <div className="flex flex-col flex-1 p-5">
                {/* Titulo + badges no mesmo flex-wrap: cada badge e um item
                    irmao do h3, entao vao quebrando de a um conforme falta
                    espaco, em vez de todos juntos pularem pra uma linha
                    separada (que era o comportamento com o wrapper proprio). */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 mb-3">
                  <h3 className="font-heading text-lg font-semibold text-warm-900 tracking-[0.01em] mr-1">
                    {room.name}
                  </h3>
                  <span
                    className="flex items-center gap-1 rounded-full bg-coral-600 text-white px-2 py-0.5 text-[10px] font-bold tracking-wide"
                    aria-label={`${room.area} metros quadrados`}
                  >
                    <MdSquareFoot size={12} />
                    {room.area}m²
                  </span>
                  <span
                    className="flex items-center gap-1 rounded-full bg-coral-600 text-white px-2 py-0.5 text-[10px] font-bold tracking-wide"
                    aria-label={`Capacidade máxima: ${room.guests} pessoas`}
                  >
                    <MdPeople size={12} />
                    Até {room.guests}
                  </span>
                  <span
                    className="flex items-center gap-1 rounded-full bg-coral-600 text-white px-2 py-0.5 text-[10px] font-bold tracking-wide"
                    aria-label="Café da manhã incluído"
                  >
                    <MdFreeBreakfast size={12} />
                    Café da manhã
                  </span>
                </div>

                <p className="font-body text-sm leading-[1.6] text-warm-800/65 line-clamp-2">
                  {room.description}
                </p>

                {/* Beds + politica de criancas/animais */}
                <div className="mt-5 flex flex-wrap items-center gap-3">
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
                  <PolicyBadge icon={MdChildFriendly} allowed={room.allowsChildren} label="Crianças" />
                  <PolicyBadge icon={MdPets} allowed={room.allowsPets} label="Animais" />
                </div>

                {/* Comodidades */}
                <div className="mt-5 flex flex-col items-center gap-1.5 border-t border-sand-200 pt-4">
                  <span className="font-body text-[9px] font-semibold uppercase tracking-[0.15em] text-warm-800/40">
                    Comodidades
                  </span>
                  <div className="flex items-center gap-3 rounded-full border border-stone-300 px-3.5 py-1.5">
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
                </div>

                {/* CTA — motor de reservas real (HQBeds). adults = capacidade do quarto,
                    para que apareça primeiro no listado (nao ha deep-link por quarto).
                    Se ja houver datas escolhidas no BookingForm, vao junto na URL; senao,
                    leva de volta ao formulario em vez de mandar sem datas.
                    mt-auto (nao flex-1 na descricao): ancora o botao no fundo do
                    card independente de quanto cresca o conteudo acima (ex.: linha
                    de camas quebrando em 2 linhas em algum card) — mantem os 3
                    botoes alinhados na mesma altura no grid. */}
                <div className="mt-auto pt-3">
                  <a
                    href={buildRoomUrl(room.guests)}
                    target={hasCompleteRange ? "_blank" : undefined}
                    rel={hasCompleteRange ? "noopener noreferrer" : undefined}
                    onClick={(e) => {
                      if (!hasCompleteRange) {
                        e.preventDefault();
                        goToBookingForm();
                        toast.show("Escolha as datas de check-in e check-out para continuar");
                      }
                    }}
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
