/*
 * Estado compartido de fechas seleccionadas en el BookingForm, para que
 * las cards de Quartos (Rooms.tsx) puedan reutilizarlas al ir a HQBeds
 * en vez de mandar sin fechas. Unica fuente de verdad: BookingForm
 * escribe (setRange), el resto de la app solo lee.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import type { DateRange } from "react-day-picker";

type BookingDatesContextValue = {
  range: DateRange | undefined;
  setRange: (range: DateRange | undefined) => void;
};

const BookingDatesContext = createContext<BookingDatesContextValue | null>(null);

export function BookingDatesProvider({ children }: { children: ReactNode }) {
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  return <BookingDatesContext.Provider value={{ range, setRange }}>{children}</BookingDatesContext.Provider>;
}

export function useBookingDates() {
  const ctx = useContext(BookingDatesContext);
  if (!ctx) throw new Error("useBookingDates debe usarse dentro de BookingDatesProvider");
  return ctx;
}
