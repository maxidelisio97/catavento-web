/*
 * Comodidades compartidas por todos los quartos (misma lista en la card de
 * Rooms.tsx y en el detalle del RoomBookingModal). Unica fuente de verdad
 * para no desincronizar los dos lugares que la usan.
 */
import { MdAcUnit, MdWifi, MdShower } from "react-icons/md";
import { PiFanFill, PiTowel } from "react-icons/pi";

export const ROOM_AMENITIES = [
  { icon: MdAcUnit, label: "Ar-condicionado" },
  { icon: PiFanFill, label: "Ventilador de teto" },
  { icon: MdWifi, label: "Wi-Fi gratuito" },
  { icon: MdShower, label: "Banheiro privativo com água quente" },
  { icon: PiTowel, label: "Roupa de cama e toalhas" },
] as const;
