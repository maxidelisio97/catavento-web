/*
 * Renderiza la seccion de habitaciones y sus tarjetas.
 * Aca debo cambiar nombres, descripciones, imagenes y amenities de cuartos.
 * Tambien arma el enlace de reserva por WhatsApp para cada habitacion.
 */
import type { IconType } from "react-icons";
import {
  MdPeople,
  MdSquareFoot,
  MdKingBed,
  MdSingleBed,
  MdChildFriendly,
  MdPets,
  MdCheck,
  MdClose,
  MdFreeBreakfast,
  MdStairs,
} from "react-icons/md";
import { useState } from "react";
import { assetPath } from "../config/site";
import { trackEvent } from "../lib/analytics";
import { ROOM_AMENITIES } from "../lib/roomAmenities";
import { WavesIcon, CoffeeIcon, ParkingIcon, TransferIcon } from "./icons";
import Carousel from "./Carousel";
import RoomBookingModal, { type ModalRoom } from "./RoomBookingModal";

const ROOMS = [
  {
    name: "Suíte Casal",
    description: "Ideal para casais ou viajantes individuais.",
    images: [
      { src: assetPath("images/Cuarto Casal/Cuarto-Casal1.webp"), alt: "Suíte Casal — cama de casal com painel decorativo de fibra na parede" },
      { src: assetPath("images/Cuarto Casal/Cuarto-Casal2.webp"), alt: "Suíte Casal — outro ângulo do quarto com a cama de casal" },
      { src: assetPath("images/Cuarto Casal/Cuarto-Casal3.webp"), alt: "Suíte Casal — banheiro com pia dupla e espelhos" },
      { src: assetPath("images/Cuarto Casal/Cuarto-Casal4.webp"), alt: "Suíte Casal — banheiro com vaso sanitário e box" },
      { src: assetPath("images/Cuarto Casal/Cuarto-Casal5.webp"), alt: "Suíte Casal — varanda com rede e cadeiras" },
      { src: assetPath("images/Cuarto Casal/Cuarto-Casal6.webp"), alt: "Suíte Casal — detalhe decorativo com corda náutica e espelho" },
    ],
    guests: 2,
    area: 15,
    floor: "1º andar",
    beds: [{ icon: MdKingBed, count: 1, label: "Cama de casal" }],
    allowsChildren: false,
    allowsPets: false,
  },
  {
    name: "Suíte Triplo",
    description: "Ideal para casais, pequenas famílias ou amigos.",
    images: [
      { src: assetPath("images/Cuarto triplo/Cuarto-triple1.webp"), alt: "Suíte Triplo — cama de casal e cama de solteiro com remos decorativos na parede" },
      { src: assetPath("images/Cuarto triplo/Cuarto-triple2.webp"), alt: "Suíte Triplo — outro ângulo do quarto com as camas e decoração náutica" },
      { src: assetPath("images/Cuarto triplo/Cuarto-triple3.webp"), alt: "Suíte Triplo — área de armários e espelho do quarto" },
      { src: assetPath("images/Cuarto triplo/Cuarto-triple4.webp"), alt: "Suíte Triplo — pia do banheiro com espelho e amenities" },
      { src: assetPath("images/Cuarto triplo/cuarto-triplo5.webp"), alt: "Suíte Triplo — banheiro com vaso sanitário e chuveiro" },
      { src: assetPath("images/Cuarto triplo/cuarto-triplo6.webp"), alt: "Suíte Triplo — varanda com mesa, cadeiras e rede" },
    ],
    guests: 3,
    area: 25,
    floor: "Térreo",
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
      { src: assetPath("images/Cuarto Cuadruplo/Cuarto-Cuadruple1.webp"), alt: "Suíte Quádruplo — três camas com remos e peixinhos decorativos na parede" },
      { src: assetPath("images/Cuarto Cuadruplo/Cuarto-Cuadruple2.webp"), alt: "Suíte Quádruplo — outro ângulo do quarto com as três camas" },
      { src: assetPath("images/Cuarto Cuadruplo/Cuarto-Cuadruple3.webp"), alt: "Suíte Quádruplo — varanda com rede, mesa e cadeiras" },
      { src: assetPath("images/Cuarto Cuadruplo/Cuarto-Cuadruple4.webp"), alt: "Suíte Quádruplo — banheiro com vaso sanitário e chuveiro" },
      { src: assetPath("images/Cuarto Cuadruplo/Cuarto-Cuadruple5.webp"), alt: "Suíte Quádruplo — banheiro com pia e espelho" },
      { src: assetPath("images/Cuarto Cuadruplo/Cuarto-Cuadruple6.webp"), alt: "Suíte Quádruplo — área externa com teto de palha e coqueiros" },
    ],
    guests: 4,
    area: 30,
    floor: "Térreo",
    beds: [
      { icon: MdKingBed, count: 1, label: "Cama de casal" },
      { icon: MdSingleBed, count: 2, label: "Camas de solteiro" },
    ],
    allowsChildren: true,
    allowsPets: true,
  },
] as const;

// Diferenciais a nivel propriedade (nao por quarto — as comodidades de cada
// quarto ja aparecem em cada card/no RoomBookingModal, nao se repetem aqui).
const STATS = [
  { value: "3+", label: "Anos de hospitalidade" },
  { value: "100m", label: "Da praia" },
  { value: "8,8", label: "Avaliação no Booking" },
  { value: "200m", label: "Do mirante" },
] as const;

const DIFERENCIAIS = [
  { icon: WavesIcon, label: "Piscina" },
  { icon: CoffeeIcon, label: "Café da manhã incluso" },
  { icon: ParkingIcon, label: "Estacionamento" },
  { icon: TransferIcon, label: "Transfer desde o aeroporto" },
] as const;

type PolicyBadgeProps = { icon: IconType; allowed: boolean; label: string };

function PolicyBadge({ icon: Icon, allowed, label }: PolicyBadgeProps) {
  return (
    <span
      className="flex items-center gap-1 rounded-full border border-pill-border px-2 py-0.5 text-label"
      title={`${label}: ${allowed ? "permitido" : "não permitido"}`}
      aria-label={`${label}: ${allowed ? "permitido" : "não permitido"}`}
    >
      <Icon size={13} />
      {allowed ? <MdCheck size={12} className="text-terracota" /> : <MdClose size={12} className="text-ink/30" />}
    </span>
  );
}

export default function Rooms() {
  const [openRoom, setOpenRoom] = useState<ModalRoom | null>(null);

  return (
    <section id="quartos" className="relative pt-24 md:pt-36 pb-16 md:pb-20 bg-offwhite">
      <div className="max-w-[1440px] mx-auto px-6 md:px-10">
        {/* Section header */}
        <div className="text-center">
          <div className="flex items-center justify-center gap-5 mb-5">
            <span className="w-12 h-px bg-rule" />
            <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-terracota-text">
              Sua Estadia
            </span>
            <span className="w-12 h-px bg-rule" />
          </div>
          <h2 className="font-heading text-4xl md:text-5xl font-semibold text-madera leading-[0.98] tracking-tight">
            Nossos Quartos
          </h2>
          <p className="mt-4 font-body text-base text-ink/85 max-w-[45ch] mx-auto leading-relaxed">
            Conforto e aconchego em cada detalhe, pensados para a melhor estadia.
          </p>
        </div>

        {/* Room cards */}
        <div className="mt-14 grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
          {ROOMS.map((room, i) => (
            <article
              key={room.name}
              className="group flex flex-col bg-white overflow-hidden"
            >
              {/* Image carousel */}
              <Carousel
                images={room.images}
                className="w-full h-full object-contain"
                wrapperClassName="h-[325px] md:h-[400px] bg-pill"
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
                  <h3 className="font-heading text-lg font-semibold text-madera tracking-[0.01em] mr-1">
                    {room.name}
                  </h3>
                  <span
                    className="flex items-center gap-1 rounded-full bg-terracota-text text-offwhite px-2 py-0.5 text-[10px] font-bold tracking-wide"
                    aria-label={`${room.area} metros quadrados`}
                  >
                    <MdSquareFoot size={12} />
                    {room.area}m²
                  </span>
                  <span
                    className="flex items-center gap-1 rounded-full bg-terracota-text text-offwhite px-2 py-0.5 text-[10px] font-bold tracking-wide"
                    aria-label={`Capacidade máxima: ${room.guests} pessoas`}
                  >
                    <MdPeople size={12} />
                    Até {room.guests}
                  </span>
                  <span
                    className="flex items-center gap-1 rounded-full bg-terracota-text text-offwhite px-2 py-0.5 text-[10px] font-bold tracking-wide"
                    aria-label="Café da manhã incluído"
                  >
                    <MdFreeBreakfast size={12} />
                    Café da manhã
                  </span>
                </div>

                <p className="font-body text-sm leading-[1.6] text-ink/85 line-clamp-2">
                  {room.description}
                </p>

                {/* Beds + andar + politica de criancas/animais */}
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  {room.beds.map((bed) => (
                    <span
                      key={bed.label}
                      className="flex items-center gap-1.5 text-ink/70"
                      aria-label={`${bed.count} ${bed.label}`}
                    >
                      <bed.icon size={18} className="text-terracota" />
                      <span className="font-body text-xs">
                        {bed.count > 1 ? `${bed.count}×` : ""} {bed.label}
                      </span>
                    </span>
                  ))}
                  <span className="flex items-center gap-1.5 text-ink/70" aria-label={room.floor}>
                    <MdStairs size={18} className="text-terracota" />
                    <span className="font-body text-xs">{room.floor}</span>
                  </span>
                  <PolicyBadge icon={MdChildFriendly} allowed={room.allowsChildren} label="Crianças" />
                  <PolicyBadge icon={MdPets} allowed={room.allowsPets} label="Animais" />
                </div>

                {/* Comodidades */}
                <div className="mt-5 flex flex-col items-center gap-1.5 border-t border-rule pt-4">
                  <span className="font-body text-[9px] font-semibold uppercase tracking-[0.15em] text-label">
                    Comodidades
                  </span>
                  <div className="flex items-center gap-3 rounded-full border border-pill-border px-3.5 py-1.5">
                    {ROOM_AMENITIES.map((a) => (
                      <span
                        key={a.label}
                        className="flex items-center gap-1.5 text-ink/70"
                        title={a.label}
                        aria-label={a.label}
                      >
                        <a.icon size={16} />
                      </span>
                    ))}
                  </div>
                </div>

                {/* CTA — abre o RoomBookingModal com esta habitacao (fechas +
                    hospedes escolhidos ali dentro, redireciona a HQBeds no
                    confirmar). mt-auto (nao flex-1 na descricao): ancora o
                    botao no fundo do card independente de quanto cresca o
                    conteudo acima (ex.: linha de camas quebrando em 2 linhas
                    em algum card) — mantem os 3 botoes alinhados na mesma
                    altura no grid. */}
                <div className="mt-auto pt-3">
                  <button
                    type="button"
                    onClick={() => {
                      trackEvent("click_reservar_card", { habitacion: room.name });
                      setOpenRoom({
                        name: room.name,
                        description: room.description,
                        guests: room.guests,
                        area: room.area,
                        floor: room.floor,
                        beds: room.beds,
                        allowsChildren: room.allowsChildren,
                        allowsPets: room.allowsPets,
                      });
                    }}
                    className="w-full flex items-center justify-center bg-terracota-text hover:brightness-110 text-offwhite font-body font-semibold text-[11px] uppercase tracking-[0.1em] py-2.5 rounded transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracota"
                  >
                    Reservar
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>

      {/* Stats + diferenciais a nivel propriedade — versao clara da "banda"
          do manual de marca (paleta propria, ver index.css). Full-bleed com
          hairlines (border-y), sem card nem fundo escuro — versao anterior
          era bg-madera contida, essa e o oposto: leve, sai do
          max-w-[1440px] do container acima de proposito. */}
      <div className="mt-16 bg-cream border-y border-pill-border">
        <div className="max-w-[1100px] mx-auto px-8 md:px-12 py-10">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {STATS.map((stat, i) => (
              <div
                key={stat.label}
                className={`text-center px-4 ${i < STATS.length - 1 ? "md:border-r md:border-rule" : ""}`}
              >
                <p className="font-heading font-semibold text-4xl leading-none text-terracota">{stat.value}</p>
                <p className="mt-2.5 font-body text-[11px] uppercase tracking-[0.13em] leading-snug text-label">
                  {stat.label}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-8 pt-6 border-t border-rule flex flex-wrap justify-center gap-2.5">
            {DIFERENCIAIS.map((item) => (
              <span
                key={item.label}
                className="inline-flex items-center gap-2 rounded-full border border-pill-border bg-pill px-4 py-2 font-body text-sm text-ink"
              >
                <item.icon className="w-[18px] h-[18px] text-terracota" />
                {item.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      <RoomBookingModal room={openRoom} onClose={() => setOpenRoom(null)} />
    </section>
  );
}
