/*
 * Paso 1 de /reservar: fechas + hospedes. Reusa el patron visual del
 * BookingForm del hero (react-day-picker + stepper), pero simplificado:
 * un solo contador de hospedes (el modelo de reservations es guests
 * total, sin distincion adultos/criancas como el motor HQBeds).
 */
import { useId, useState } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import { ptBR } from "react-day-picker/locale";
import "react-day-picker/style.css";
import { LuCircleAlert, LuMinus, LuPlus, LuUsers } from "react-icons/lu";
import { toIsoDate } from "../../lib/dates";

const MIN_GUESTS = 1;
const MAX_GUESTS = 10;

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

export interface DatesStepInitial {
  checkIn?: string;
  checkOut?: string;
  guests?: number;
  errorMessage?: string;
}

interface DatesStepProps {
  initial?: DatesStepInitial;
  onSubmit: (values: { checkIn: string; checkOut: string; guests: number }) => void;
}

function isoToDate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export default function DatesStep({ initial, onSubmit }: DatesStepProps) {
  const [range, setRange] = useState<DateRange | undefined>(
    initial?.checkIn && initial?.checkOut
      ? { from: isoToDate(initial.checkIn), to: isoToDate(initial.checkOut) }
      : undefined,
  );
  const [guests, setGuests] = useState(initial?.guests ?? 2);
  const [error, setError] = useState<string | undefined>(initial?.errorMessage);
  const errorId = useId();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!range?.from || !range?.to) {
      setError("Escolha as datas de check-in e check-out.");
      return;
    }
    if (range.to <= range.from) {
      setError("O check-out precisa ser depois do check-in.");
      return;
    }

    setError(undefined);
    onSubmit({ checkIn: toIsoDate(range.from), checkOut: toIsoDate(range.to), guests });
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-md mx-auto space-y-6">
      <div>
        <h2 className="font-heading text-2xl text-warm-900">Quando você vem?</h2>
        <p className="mt-1 font-body text-sm text-warm-800/60">Escolha as datas e quantos hóspedes vão ficar.</p>
      </div>

      <div className="flex justify-center rounded-2xl border border-stone-300 bg-white p-4">
        <DayPicker
          mode="range"
          locale={ptBR}
          selected={range}
          onSelect={setRange}
          defaultMonth={range?.from}
          disabled={{ before: startOfToday() }}
          showOutsideDays
          navLayout="around"
          className="booking-daypicker font-body"
        />
      </div>

      <div className="flex items-center justify-between rounded-2xl border border-stone-300 bg-white px-5 py-4">
        <div className="flex items-center gap-2">
          <LuUsers size={18} className="text-warm-800/40" aria-hidden />
          <span className="font-body text-sm font-medium text-warm-900">Hóspedes</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="Diminuir hóspedes"
            disabled={guests <= MIN_GUESTS}
            onClick={() => setGuests((g) => Math.max(MIN_GUESTS, g - 1))}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-300 text-warm-800 transition-colors hover:border-coral-500 hover:text-coral-600 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <LuMinus size={14} />
          </button>
          <span className="w-4 text-center font-body text-sm font-semibold tabular-nums text-warm-900">
            {guests}
          </span>
          <button
            type="button"
            aria-label="Aumentar hóspedes"
            disabled={guests >= MAX_GUESTS}
            onClick={() => setGuests((g) => Math.min(MAX_GUESTS, g + 1))}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-300 text-warm-800 transition-colors hover:border-coral-500 hover:text-coral-600 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <LuPlus size={14} />
          </button>
        </div>
      </div>

      {error && (
        <p id={errorId} role="alert" className="flex items-start gap-1.5 font-body text-sm text-coral-600">
          <LuCircleAlert size={16} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </p>
      )}

      <button
        type="submit"
        className="w-full h-14 rounded-2xl bg-coral-600 hover:bg-coral-500 text-white font-body font-semibold transition-colors active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-400"
      >
        Ver disponibilidade
      </button>
    </form>
  );
}
