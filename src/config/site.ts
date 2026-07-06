/*
 * Centraliza datos generales del sitio que se reutilizan en varias secciones.
 * Aca debo cambiar enlaces, telefono, redes sociales y navegacion compartida.
 * Sirve para evitar buscar el mismo dato repetido en muchos componentes.
 */

export const NAV_ITEMS = [
  { label: "Início", href: "#hero" },
  { label: "Experiências", href: "#experiencias" },
  { label: "Quartos", href: "#quartos" },
  { label: "Taíba", href: "#taiba" },
  { label: "Galeria", href: "#galeria" },
] as const;

export const WHATSAPP_URL = "https://wa.link/gzgaap";
export const WHATSAPP_NUMBER = "5599992325903";
export const PHONE_DISPLAY = "+55 99 99232-5903";
export const INSTAGRAM_URL = "https://www.instagram.com/pousadacatavento";
// Ya no es canal de reserva: solo se usa como atribucion de resenas (Testimonials, schema.org).
export const BOOKING_URL = "https://www.booking.com/hotel/br/pousada-catavento.html";
export const MAPS_URL = "https://www.google.com/maps/search/Pousada+Catavento+Taiba";

// Motor de reservas real (HQBeds).
//
// Verificado con Playwright (2026-07-05): la habitacion elegida vive en la
// sesion/carrito del motor, nunca en la URL — no existe forma de deep-link a un
// quarto especifico. Ir directo a /checkout sin pasar antes por /rooms en esa
// misma sesion (carrito vacio) redirige automaticamente de vuelta a /rooms. Por
// eso TODOS los links de reserva apuntan siempre a /rooms, nunca a /checkout.
//
// Si encontramos algo util: el parametro adults reordena el listado por mejor
// encaje (con adults=4 la Suite Quadruplo pasa a aparecer primera). Por eso,
// cuando el usuario elige un tipo de quarto sin especificar huespedes, mandamos
// la capacidad maxima de ese quarto como adults — no preselecciona el quarto,
// pero lo hace aparecer primero en el motor.
const HQBEDS_ROOMS_URL = "https://booking.hqbeds.com.br/cataventotaiba/rooms";

export const ROOM_TYPES = [
  { id: "casal", label: "Suíte Casal", capacity: 2 },
  { id: "triplo", label: "Suíte Triplo", capacity: 3 },
  { id: "quadruplo", label: "Suíte Quádruplo", capacity: 4 },
] as const;

export type RoomTypeId = (typeof ROOM_TYPES)[number]["id"];

export function buildHqbedsUrl(params?: {
  arrival?: string;
  departure?: string;
  adults?: number;
  children?: number;
}) {
  const search = new URLSearchParams();
  if (params?.arrival) search.set("arrival", params.arrival);
  if (params?.departure) search.set("departure", params.departure);
  search.set("adults", String(params?.adults ?? 2));
  search.set("children", String(params?.children ?? 0));
  return `${HQBEDS_ROOMS_URL}?${search.toString()}`;
}

export function assetPath(path: string) {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;
}
