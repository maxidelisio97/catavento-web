/*
 * Estado compartido de fechas seleccionadas en el RoomBookingModal. Vive
 * en Context (no en el propio drawer) para sobrevivir a que el usuario
 * cierre el modal de un quarto y abra el de otro: las fechas elegidas se
 * mantienen en vez de resetear cada vez que el drawer se desmonta.
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
