/*
 * Logica compartida de submit entre BookingForm.tsx (form principal) e
 * RoomBookingModal.tsx (drawer de reserva por habitacao): validacao de
 * datas, estado de hospedes, e o redirecionamento a HQBeds com o evento
 * correto (ver nota de eventos separados em BookingForm.tsx/git history).
 */
import { useState } from "react";
import { buildHqbedsUrl } from "../config/site";
import { trackEvent } from "./analytics";
import { useBookingDates } from "./bookingDates";
import { toIsoDate } from "./dates";
import { startOfToday } from "./bookingRange";

type Room = { name: string; guests: number };

export function useBookingSubmit(room?: Room) {
  const { range, setRange } = useBookingDates();
  const [adults, setAdults] = useState(room?.guests ?? 2);
  const [children, setChildren] = useState(0);
  const [datesError, setDatesError] = useState<string | undefined>(undefined);

  function submit(): { ok: boolean } {
    let error: string | undefined;
    if (!range?.from || !range?.to) {
      error = "Escolha as datas de check-in e check-out.";
    } else if (range.from < startOfToday()) {
      error = "A data de check-in não pode ser no passado.";
    } else if (range.to <= range.from) {
      error = "O check-out precisa ser depois do check-in.";
    }

    setDatesError(error);
    if (error) return { ok: false };

    const arrival = toIsoDate(range!.from!);
    const departure = toIsoDate(range!.to!);
    const url = buildHqbedsUrl({ arrival, departure, adults, children });

    if (room) {
      trackEvent("confirmar_reserva_popup", {
        habitacion: room.name,
        checkin: arrival,
        checkout: departure,
        adultos: adults,
        criancas: children,
      });
    } else {
      trackEvent("click_verificar_disponibilidad", { arrival, departure, adults, children });
    }

    window.open(url, "_blank", "noopener,noreferrer");
    return { ok: true };
  }

  return { range, setRange, adults, setAdults, children, setChildren, datesError, submit };
}
