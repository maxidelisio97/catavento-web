/*
 * Drawer de reserva por habitacao: abre desde o botao "Reservar" de cada
 * card em Rooms.tsx. Entra pela direita (nao centralizado na tela) e nao
 * mostra fotos — a foto ja apareceu na propria card antes do clique. E o
 * unico ponto de reserva do site (o form de disponibilidade do Hero foi
 * removido): aqui o quarto se explica por extenso (descricao, comodidades
 * com rotulo, politica de criancas/animais) antes de pedir fechas + hospedes.
 *
 * Calendario e contadores de hospedes ficam sempre visiveis (sem popover)
 * porque o drawer tem espaco vertical de sobra, e o botao final e um botao
 * retangular full-width comum.
 *
 * Fechamento manual (X, click fora, Escape).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { DayPicker, type DateRange, type DayButtonProps } from "react-day-picker";
import { ptBR } from "react-day-picker/locale";
import "react-day-picker/style.css";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import type { IconType } from "react-icons";
import { LuArrowRight, LuCircleAlert } from "react-icons/lu";
import { MdClose, MdSquareFoot, MdPeople, MdFreeBreakfast, MdStairs } from "react-icons/md";
import { formatRangeLabel, isPickingCheckout, startOfToday } from "../lib/bookingRange";
import { useBookingSubmit } from "../lib/useBookingSubmit";
import { MAX_GUESTS, MIN_ADULTS, MIN_CHILDREN } from "../lib/guestLimits";
import { EASE } from "../lib/motion";
import { ROOM_AMENITIES } from "../lib/roomAmenities";
import { ChildIcon, PetsIcon, CheckIcon, CancelIcon } from "./icons";
import GuestCounterRow from "./GuestCounterRow";

export type ModalRoomBed = { icon: IconType; count: number; label: string };

export type ModalRoom = {
  name: string;
  description: string;
  guests: number;
  area: number;
  floor: string;
  beds: readonly ModalRoomBed[];
  allowsChildren: boolean;
  allowsPets: boolean;
};

type RoomBookingModalProps = {
  room: ModalRoom | null;
  onClose: () => void;
};

export default function RoomBookingModal({ room, onClose }: RoomBookingModalProps) {
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!room) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [room, onClose]);

  return (
    <AnimatePresence>
      {room && <DrawerContent room={room} onClose={onClose} reduce={Boolean(reduce)} />}
    </AnimatePresence>
  );
}

type PolicyRowProps = { icon: IconType; allowed: boolean; label: string };

function PolicyRow({ icon: Icon, allowed, label }: PolicyRowProps) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex items-center justify-center w-8 h-8 rounded-full bg-pill shrink-0">
        <Icon size={15} className="text-terracota" />
      </span>
      <p className="font-body text-sm text-ink flex-1">{label}</p>
      {allowed ? (
        <CheckIcon size={18} className="text-terracota shrink-0" aria-label="Permitido" />
      ) : (
        <CancelIcon size={18} className="text-ink/30 shrink-0" aria-label="Não permitido" />
      )}
    </div>
  );
}

type DrawerContentProps = { room: ModalRoom; onClose: () => void; reduce: boolean };

function DrawerContent({ room, onClose, reduce }: DrawerContentProps) {
  const { range, setRange, adults, setAdults, children, setChildren, datesError, submit } = useBookingSubmit(room);
  const [hoveredDay, setHoveredDay] = useState<Date | undefined>(undefined);
  const datesErrorId = useId();

  const onDayHoverRef = useRef((_date: Date) => {});
  onDayHoverRef.current = (date) => {
    if (isPickingCheckout(range)) setHoveredDay(date);
  };

  const dayPickerComponents = useMemo(
    () => ({
      DayButton: function PreviewDayButton({ day, modifiers, ...buttonProps }: DayButtonProps) {
        return (
          <button
            {...buttonProps}
            onMouseEnter={(e) => {
              buttonProps.onMouseEnter?.(e);
              if (!modifiers.disabled) onDayHoverRef.current(day.date);
            }}
          />
        );
      },
    }),
    []
  );

  const previewModifiers = useMemo(() => {
    if (!range?.from || !hoveredDay || !isPickingCheckout(range) || hoveredDay <= range.from) {
      return { previewMiddle: [], previewEnd: [] };
    }
    return {
      previewMiddle: { after: range.from, before: hoveredDay },
      previewEnd: hoveredDay,
    };
  }, [range, hoveredDay]);

  function handleRangeSelect(nextRange: DateRange | undefined) {
    setRange(nextRange);
    setHoveredDay(undefined);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  return (
    <div className="fixed inset-0 z-50">
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 bg-madera/60"
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduce ? undefined : { opacity: 0 }}
        transition={{ duration: 0.25 }}
        onClick={onClose}
      />

      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={`Reservar ${room.name}`}
        className="absolute right-0 top-0 h-full w-full max-w-md flex flex-col bg-cream shadow-2xl shadow-madera/30"
        initial={reduce ? false : { x: "100%" }}
        animate={{ x: 0 }}
        exit={reduce ? undefined : { x: "100%" }}
        transition={{ duration: 0.4, ease: EASE }}
      >
        {/* Cabecalho */}
        <div className="flex items-start justify-between gap-4 px-6 pt-6 md:px-8 md:pt-8">
          <div>
            <div className="flex items-center gap-3 mb-3">
              <span className="w-8 h-px bg-rule" />
              <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-terracota-text">
                Reservar
              </span>
            </div>
            <h2 className="font-heading text-2xl font-semibold text-madera leading-[1.05] tracking-tight">
              {room.name}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Fechar"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink/55 hover:bg-pill hover:text-madera transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracota"
          >
            <MdClose size={20} />
          </button>
        </div>

        {/* Corpo: rolavel se o conteudo passar da altura da tela */}
        <form onSubmit={handleSubmit} noValidate className="flex flex-1 flex-col overflow-y-auto px-6 pb-6 md:px-8 md:pb-8">
          <div className="flex flex-wrap items-center gap-2 mt-5 mb-3">
            <span className="flex items-center gap-1 rounded-full bg-terracota-text text-offwhite px-2.5 py-1 text-[10px] font-bold tracking-wide">
              <MdSquareFoot size={12} />
              {room.area}m²
            </span>
            <span className="flex items-center gap-1 rounded-full bg-terracota-text text-offwhite px-2.5 py-1 text-[10px] font-bold tracking-wide">
              <MdPeople size={12} />
              Até {room.guests}
            </span>
            <span className="flex items-center gap-1 rounded-full bg-terracota-text text-offwhite px-2.5 py-1 text-[10px] font-bold tracking-wide">
              <MdFreeBreakfast size={12} />
              Café da manhã
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3 mb-6">
            {room.beds.map((bed) => (
              <span key={bed.label} className="flex items-center gap-1.5 text-ink/70">
                <bed.icon size={16} className="text-terracota" />
                <span className="font-body text-xs">
                  {bed.count > 1 ? `${bed.count}×` : ""} {bed.label}
                </span>
              </span>
            ))}
            <span className="flex items-center gap-1.5 text-ink/70">
              <MdStairs size={16} className="text-terracota" />
              <span className="font-body text-xs">{room.floor}</span>
            </span>
          </div>

          <p className="font-body text-sm leading-[1.6] text-ink/85">{room.description}</p>

          {/* Comodidades: mesma lista da card, mas aqui com rotulo por
              extenso (nao so icone+tooltip) — o pedido foi deixar isso mais
              facil de entender de relance, sem precisar hover. */}
          <div className="border-t border-rule mt-6 pt-6">
            <span className="font-body text-[9px] font-semibold uppercase tracking-[0.2em] text-terracota-text">
              Comodidades
            </span>
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3.5">
              {ROOM_AMENITIES.map((a) => (
                <div key={a.label} className="flex items-center gap-2.5">
                  <span className="flex items-center justify-center w-8 h-8 rounded-full bg-pill shrink-0">
                    <a.icon size={15} className="text-terracota" />
                  </span>
                  <p className="font-body text-sm text-ink">{a.label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Politica de criancas/animais, tambem por extenso. */}
          <div className="border-t border-rule mt-6 pt-6">
            <span className="font-body text-[9px] font-semibold uppercase tracking-[0.2em] text-terracota-text">
              Política do quarto
            </span>
            <div className="mt-4 space-y-3">
              <PolicyRow icon={ChildIcon} allowed={room.allowsChildren} label="Crianças" />
              <PolicyRow icon={PetsIcon} allowed={room.allowsPets} label="Animais de estimação" />
            </div>
          </div>

          {/* Fechas: calendario sempre visivel, sem popover — o drawer tem
              espaco vertical de sobra, diferente da pildora horizontal do
              form principal. */}
          <div className="border-t border-rule mt-6 pt-6">
            <div className="flex items-center justify-between mb-3">
              <span className="font-body text-[9px] font-semibold uppercase tracking-[0.2em] text-terracota-text">
                Check-in — Check-out
              </span>
              <span className="font-body text-sm font-semibold text-madera">{formatRangeLabel(range)}</span>
            </div>
            <div
              onMouseLeave={() => setHoveredDay(undefined)}
              className="flex justify-center rounded-2xl border border-pill-border bg-offwhite p-3"
            >
              <DayPicker
                mode="range"
                locale={ptBR}
                selected={range}
                onSelect={handleRangeSelect}
                defaultMonth={range?.from}
                disabled={{ before: startOfToday() }}
                showOutsideDays
                navLayout="around"
                components={dayPickerComponents}
                modifiers={previewModifiers}
                modifiersClassNames={{ previewMiddle: "rdp-range_middle", previewEnd: "rdp-range_end" }}
                className="booking-daypicker font-body"
              />
            </div>
          </div>

          {/* Hospedes: contadores sempre visiveis, mesmo motivo acima. */}
          <div className="border-t border-rule mt-6 pt-6 space-y-4">
            <span className="font-body text-[9px] font-semibold uppercase tracking-[0.2em] text-terracota-text">
              Hóspedes
            </span>
            <GuestCounterRow
              label="Adultos"
              hint="13 anos ou mais"
              value={adults}
              min={MIN_ADULTS}
              max={MAX_GUESTS - children}
              onChange={setAdults}
            />
            <GuestCounterRow
              label="Crianças"
              hint="0 a 12 anos"
              value={children}
              min={MIN_CHILDREN}
              max={MAX_GUESTS - adults}
              onChange={setChildren}
            />
          </div>

          {datesError && (
            <p id={datesErrorId} role="alert" className="flex items-start gap-1.5 font-body text-xs text-terracota-text mt-6">
              <LuCircleAlert size={14} className="shrink-0 mt-0.5" />
              <span>{datesError}</span>
            </p>
          )}

          <button
            type="submit"
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-terracota-text hover:brightness-110 text-offwhite font-body font-semibold text-sm py-3.5 transition-all duration-200 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracota"
          >
            Reservar
            <LuArrowRight size={18} aria-hidden />
          </button>
        </form>
      </motion.div>
    </div>
  );
}
