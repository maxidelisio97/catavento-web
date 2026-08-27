/*
 * Formulario de reserva propio: reemplaza el widget embebido de HQBeds.
 * Arma la URL do motor real (siempre /rooms, nunca /checkout — ver nota en
 * config/site.ts sobre por que /checkout no sirve como deep-link) y la abre
 * en una pestana nueva. Validacion 100% client-side, sin backend.
 *
 * El motor HQBeds no permite deep-link a un tipo de quarto especifico (la
 * eleccion vive en la sesion/carrito, no en la URL), por eso este formulario
 * no ofrece selector de quarto: solo fechas y cantidad de hospedes.
 *
 * Nota de mantenimiento: la tipografia/color del calendario (react-day-picker)
 * se controla via CSS plano en index.css (.rdp-root.booking-daypicker), NUNCA
 * via el prop `classNames` del componente — ese prop REEMPLAZA (no concatena)
 * la clase default de cada parte, y pisar por ejemplo `day_button` le hace
 * perder la clase "rdp-day_button" al elemento, rompiendo silenciosamente los
 * estilos de rango (range_start/range_end) que dependen de esa clase base.
 *
 * Logica de validacion/submit vive en useBookingSubmit (compartida con el
 * drawer RoomBookingModal.tsx) — este componente solo posee el estado de
 * presentacion (popovers abiertos, hover de preview) que es especifico de
 * esta pildora horizontal.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { DayPicker, type DateRange, type DayButtonProps } from "react-day-picker";
import { ptBR } from "react-day-picker/locale";
import "react-day-picker/style.css";
import { LuArrowRight, LuCalendar, LuChevronDown, LuCircleAlert, LuUsers } from "react-icons/lu";
import { formatRangeLabel, isPickingCheckout, isSameDay, startOfToday } from "../lib/bookingRange";
import { trackEvent } from "../lib/analytics";
import { useBookingSubmit } from "../lib/useBookingSubmit";
import CataventoIcon from "./CataventoIcon";
import GuestCounterRow from "./GuestCounterRow";
import { MAX_GUESTS, MIN_ADULTS, MIN_CHILDREN } from "../lib/guestLimits";

function formatGuestsLabel(adults: number, children: number) {
  const parts = [`${adults} ${adults === 1 ? "adulto" : "adultos"}`];
  if (children > 0) parts.push(`${children} ${children === 1 ? "criança" : "crianças"}`);
  return parts.join(", ");
}

type BookingFormProps = {
  // Presente quando o form roda dentro do RoomBookingModal (uma habitacao
  // especifica); ausente no form principal do Hero.
  room?: { name: string; guests: number };
};

export default function BookingForm({ room }: BookingFormProps) {
  const { range, setRange, adults, setAdults, children, setChildren, datesError, submit } = useBookingSubmit(room);
  const [hoveredDay, setHoveredDay] = useState<Date | undefined>(undefined);
  const [isPickerOpen, setPickerOpen] = useState(false);
  const [isGuestsOpen, setGuestsOpen] = useState(false);

  const dateTriggerRef = useRef<HTMLButtonElement>(null);
  const datePopoverRef = useRef<HTMLDivElement>(null);
  const guestsTriggerRef = useRef<HTMLButtonElement>(null);
  const guestsPopoverRef = useRef<HTMLDivElement>(null);
  const datesErrorId = useId();

  // Ref (nao state) para o handler de hover do dia: o componente DayButton
  // customizado precisa ficar referencialmente estavel entre renders (senao
  // DayPicker remonta a grade inteira a cada dia sobrevoado), mas ele ainda
  // precisa disparar a versao mais recente do handler.
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

  useEffect(() => {
    if (!isPickerOpen && !isGuestsOpen) return;

    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        isPickerOpen &&
        !datePopoverRef.current?.contains(target) &&
        !dateTriggerRef.current?.contains(target)
      ) {
        setPickerOpen(false);
        setHoveredDay(undefined);
      }
      if (
        isGuestsOpen &&
        !guestsPopoverRef.current?.contains(target) &&
        !guestsTriggerRef.current?.contains(target)
      ) {
        setGuestsOpen(false);
      }
    }

    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (isPickerOpen) {
        setPickerOpen(false);
        setHoveredDay(undefined);
        dateTriggerRef.current?.focus();
      }
      if (isGuestsOpen) {
        setGuestsOpen(false);
        guestsTriggerRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isPickerOpen, isGuestsOpen]);

  function handleRangeSelect(nextRange: DateRange | undefined) {
    const wasPickingCheckout = isPickingCheckout(range);
    const completed = Boolean(nextRange?.from && nextRange?.to && !isSameDay(nextRange.to, nextRange.from!));
    setRange(nextRange);
    setHoveredDay(undefined);
    if (wasPickingCheckout && completed) {
      setPickerOpen(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = submit();
    if (!result.ok) setPickerOpen(true);
  }

  const labelClass =
    "flex items-center gap-1.5 font-body text-[9px] font-semibold uppercase tracking-[0.2em] text-terracota-text";
  const iconClass = "shrink-0 text-ink/40";
  const valueClass = "mt-1 font-body text-base font-semibold tracking-tight text-madera truncate";
  const valuePlaceholderClass = "mt-1 font-body text-base font-normal text-ink/45 truncate";
  const cellButtonClass =
    "w-full h-full text-left px-5 py-3.5 flex flex-col hover:bg-pill transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-terracota";

  return (
    <form onSubmit={handleSubmit} noValidate className="w-full">
      <div className="flex flex-col md:flex-row md:items-center gap-3 w-full">
        {/* Pildora: fechas + hospedes */}
        <div className="flex flex-col md:flex-row md:flex-1 w-full rounded-2xl md:rounded-full border border-pill-border bg-white divide-y divide-pill-border md:divide-y-0 md:divide-x">
          {/* Fechas */}
          <div className="relative flex-[1.3] min-w-0">
            <button
              ref={dateTriggerRef}
              type="button"
              onClick={() => {
                if (!isPickerOpen && !room) trackEvent("click_calendario_disponibilidad");
                setPickerOpen((open) => !open);
              }}
              aria-haspopup="dialog"
              aria-expanded={isPickerOpen}
              aria-invalid={Boolean(datesError)}
              aria-describedby={datesError ? datesErrorId : undefined}
              className={`${cellButtonClass} rounded-tl-2xl rounded-tr-2xl md:rounded-tl-full md:rounded-bl-full md:rounded-tr-none md:rounded-br-none`}
            >
              <span className={labelClass}>
                <LuCalendar size={16} className={iconClass} />
                Check-in — Check-out
              </span>
              <span className={range?.from ? valueClass : valuePlaceholderClass}>{formatRangeLabel(range)}</span>
            </button>

            {isPickerOpen && (
              <>
                <div className="fixed inset-0 z-20 bg-madera/25 md:hidden" aria-hidden />
                <div
                  ref={datePopoverRef}
                  role="dialog"
                  aria-label="Selecionar datas da estadia"
                  onMouseLeave={() => setHoveredDay(undefined)}
                  className="absolute z-30 left-0 top-full mt-2 w-[340px] max-w-[92vw] rounded-2xl border border-pill-border bg-cream p-4 shadow-xl shadow-madera/20"
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
              </>
            )}
          </div>

          {/* Hospedes */}
          <div className="relative flex-1 min-w-0">
            <button
              ref={guestsTriggerRef}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={isGuestsOpen}
              onClick={() => setGuestsOpen((open) => !open)}
              className={`${cellButtonClass} rounded-bl-2xl rounded-br-2xl md:rounded-tr-full md:rounded-br-full md:rounded-tl-none md:rounded-bl-none`}
            >
              <span className={labelClass}>
                <LuUsers size={16} className={iconClass} />
                Hóspedes
              </span>
              <span className="mt-1 flex items-center justify-between gap-2">
                <span className={valueClass}>{formatGuestsLabel(adults, children)}</span>
                <LuChevronDown
                  size={14}
                  aria-hidden
                  className={`shrink-0 text-ink/40 transition-transform duration-200 ${isGuestsOpen ? "rotate-180" : ""}`}
                />
              </span>
            </button>

            {isGuestsOpen && (
              <div
                ref={guestsPopoverRef}
                role="dialog"
                aria-label="Selecionar hóspedes"
                className="absolute z-30 left-0 top-full mt-2 w-full min-w-[260px] space-y-4 rounded-2xl border border-pill-border bg-cream p-4 shadow-xl shadow-madera/20"
              >
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
            )}
          </div>
        </div>

        {/* Verificar: em mobile, botao full-width com icone estatico + texto
            (o morph de hover nao existe em touch, entao o icone-solo perderia
            sentido ali). Em md+: circular solo-icone (Variante B) — o molino
            gira devagar em repouso; no hover "voa" para fora do botao com 2
            tracos finos de vento acompanhando, enquanto uma seta entra do
            lado oposto — ver .verificar-btn/.verificar-wind em index.css. */}
        <button
          type="submit"
          aria-label="Verificar disponibilidade"
          className="verificar-btn group relative self-center shrink-0 flex items-center justify-center gap-2 w-full md:w-16 h-14 md:h-16 rounded-2xl md:rounded-full bg-terracota-text hover:brightness-110 text-offwhite md:overflow-hidden transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracota"
        >
          <span className="verificar-icon flex items-center justify-center md:absolute md:inset-0">
            <CataventoIcon height={40} className="w-[16px] h-[20px] md:w-8 md:h-[40px]" />
          </span>
          <span className="font-body font-semibold text-sm md:hidden">Verificar</span>
          <span className="verificar-wind hidden md:block" aria-hidden>
            <span />
            <span />
          </span>
          <span className="verificar-arrow hidden md:flex md:absolute md:inset-0 items-center justify-center">
            <LuArrowRight size={22} aria-hidden />
          </span>
        </button>
      </div>

      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${
          datesError ? "grid-rows-[1fr] mt-3" : "grid-rows-[0fr] mt-0"
        }`}
      >
        <div className="overflow-hidden">
          {datesError && (
            <p
              id={datesErrorId}
              role="alert"
              className="flex items-start gap-1.5 font-body text-xs text-terracota-text"
            >
              <LuCircleAlert size={14} className="shrink-0 mt-0.5" />
              <span>{datesError}</span>
            </p>
          )}
        </div>
      </div>
    </form>
  );
}
