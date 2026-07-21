/*
 * Paso 1 de /reservar: fechas + hospedes. Reusa el patron visual del
 * BookingForm del hero (react-day-picker + stepper), con tres contadores
 * (adultos/criancas/bebes) — o backend distingue adultos-only (Casal),
 * capacidade (criancas contam, bebes nao) e idade por crianca.
 */
import { useId, useState } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import { ptBR } from "react-day-picker/locale";
import "react-day-picker/style.css";
import { LuBaby, LuCircleAlert, LuMinus, LuPlus, LuUsers } from "react-icons/lu";
import { toIsoDate } from "../../lib/dates";

const MIN_ADULTS = 1;
const MAX_ADULTS = 10;
const MIN_CHILDREN = 0;
const MAX_CHILDREN = 8;
const MIN_BABIES = 0;
const MAX_BABIES = 4;
const MIN_CHILD_AGE = 3;
const MAX_CHILD_AGE = 17;
const DEFAULT_CHILD_AGE = 3;

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

export interface DatesStepInitial {
  checkIn?: string;
  checkOut?: string;
  guests?: number;
  children?: number;
  babies?: number;
  childrenAges?: number[];
  errorMessage?: string;
}

interface DatesStepProps {
  initial?: DatesStepInitial;
  onSubmit: (values: {
    checkIn: string;
    checkOut: string;
    guests: number;
    children: number;
    babies: number;
    childrenAges: number[];
  }) => void;
}

function isoToDate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function clampChildAge(raw: string): number | null {
  const digits = raw.replace(/\D/g, "");
  if (digits === "") return null;
  const value = Number(digits);
  return Math.min(MAX_CHILD_AGE, Math.max(MIN_CHILD_AGE, value));
}

export default function DatesStep({ initial, onSubmit }: DatesStepProps) {
  const [range, setRange] = useState<DateRange | undefined>(
    initial?.checkIn && initial?.checkOut
      ? { from: isoToDate(initial.checkIn), to: isoToDate(initial.checkOut) }
      : undefined,
  );
  const [guests, setGuests] = useState(initial?.guests ?? 2);
  const [children, setChildren] = useState(initial?.children ?? 0);
  const [babies, setBabies] = useState(initial?.babies ?? 0);
  const [childrenAges, setChildrenAges] = useState<number[]>(
    initial?.childrenAges?.slice(0, initial?.children ?? 0) ??
      Array.from({ length: initial?.children ?? 0 }, () => DEFAULT_CHILD_AGE),
  );
  const [error, setError] = useState<string | undefined>(initial?.errorMessage);
  const errorId = useId();

  function updateChildrenCount(next: number) {
    const clamped = Math.min(MAX_CHILDREN, Math.max(MIN_CHILDREN, next));
    setChildren(clamped);
    setChildrenAges((prev) => {
      if (clamped === prev.length) return prev;
      if (clamped < prev.length) return prev.slice(0, clamped);
      return [...prev, ...Array.from({ length: clamped - prev.length }, () => DEFAULT_CHILD_AGE)];
    });
  }

  function updateChildAge(index: number, raw: string) {
    setChildrenAges((prev) => {
      const next = [...prev];
      const parsed = clampChildAge(raw);
      next[index] = parsed ?? MIN_CHILD_AGE;
      return next;
    });
  }

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
    onSubmit({
      checkIn: toIsoDate(range.from),
      checkOut: toIsoDate(range.to),
      guests,
      children,
      babies,
      childrenAges,
    });
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

      <div className="rounded-2xl border border-stone-300 bg-white divide-y divide-stone-200">
        <div className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2">
            <LuUsers size={18} className="text-warm-800/40" aria-hidden />
            <span className="font-body text-sm font-medium text-warm-900">Adultos</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Diminuir adultos"
              disabled={guests <= MIN_ADULTS}
              onClick={() => setGuests((g) => Math.max(MIN_ADULTS, g - 1))}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-300 text-warm-800 transition-colors hover:border-coral-500 hover:text-coral-600 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <LuMinus size={14} />
            </button>
            <span className="w-4 text-center font-body text-sm font-semibold tabular-nums text-warm-900">
              {guests}
            </span>
            <button
              type="button"
              aria-label="Aumentar adultos"
              disabled={guests >= MAX_ADULTS}
              onClick={() => setGuests((g) => Math.min(MAX_ADULTS, g + 1))}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-300 text-warm-800 transition-colors hover:border-coral-500 hover:text-coral-600 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <LuPlus size={14} />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2">
            <LuUsers size={18} className="text-warm-800/40" aria-hidden />
            <span className="font-body text-sm font-medium text-warm-900">Crianças (3 a 17 anos)</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Diminuir crianças"
              disabled={children <= MIN_CHILDREN}
              onClick={() => updateChildrenCount(children - 1)}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-300 text-warm-800 transition-colors hover:border-coral-500 hover:text-coral-600 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <LuMinus size={14} />
            </button>
            <span className="w-4 text-center font-body text-sm font-semibold tabular-nums text-warm-900">
              {children}
            </span>
            <button
              type="button"
              aria-label="Aumentar crianças"
              disabled={children >= MAX_CHILDREN}
              onClick={() => updateChildrenCount(children + 1)}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-300 text-warm-800 transition-colors hover:border-coral-500 hover:text-coral-600 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <LuPlus size={14} />
            </button>
          </div>
        </div>

        {children > 0 && (
          <div className="px-5 py-4 space-y-3">
            <p className="font-body text-xs font-semibold uppercase tracking-[0.1em] text-warm-800/60">
              Idade das crianças
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {childrenAges.map((age, index) => (
                <label key={index} className="flex flex-col gap-1">
                  <span className="font-body text-xs text-warm-800/60">Criança {index + 1}</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={MIN_CHILD_AGE}
                    max={MAX_CHILD_AGE}
                    value={age}
                    onChange={(e) => updateChildAge(index, e.target.value)}
                    className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 font-body text-sm text-warm-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-400"
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2">
            <LuBaby size={18} className="text-warm-800/40" aria-hidden />
            <span className="font-body text-sm font-medium text-warm-900">Bebês (até 2 anos, não ocupam vaga)</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Diminuir bebês"
              disabled={babies <= MIN_BABIES}
              onClick={() => setBabies((b) => Math.max(MIN_BABIES, b - 1))}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-300 text-warm-800 transition-colors hover:border-coral-500 hover:text-coral-600 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <LuMinus size={14} />
            </button>
            <span className="w-4 text-center font-body text-sm font-semibold tabular-nums text-warm-900">
              {babies}
            </span>
            <button
              type="button"
              aria-label="Aumentar bebês"
              disabled={babies >= MAX_BABIES}
              onClick={() => setBabies((b) => Math.min(MAX_BABIES, b + 1))}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-300 text-warm-800 transition-colors hover:border-coral-500 hover:text-coral-600 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <LuPlus size={14} />
            </button>
          </div>
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
