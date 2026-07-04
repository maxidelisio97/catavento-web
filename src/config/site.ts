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
export const BOOKING_URL = "https://www.booking.com/hotel/br/pousada-catavento.html";
export const MAPS_URL = "https://www.google.com/maps/search/Pousada+Catavento+Taiba";

export function assetPath(path: string) {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;
}
