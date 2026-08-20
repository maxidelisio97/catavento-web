/*
 * Construye el footer y la llamada final a reservar.
 * Contiene contacto, redes, navegacion secundaria y direccion.
 * Si necesito editar informacion de contacto o pie de pagina, voy aca.
 */
import { MdWhatsapp, MdPhone, MdLocationOn } from "react-icons/md";
import { FaInstagram } from "react-icons/fa";
import {
  INSTAGRAM_URL,
  MAPS_URL,
  NAV_ITEMS,
  PHONE_DISPLAY,
  WHATSAPP_NUMBER,
  WHATSAPP_URL,
} from "../config/site";
import { trackEvent } from "../lib/analytics";
import { goToRooms } from "../lib/scroll";


export default function Reservation() {
  return (
    <footer id="reservar" className="relative bg-madera text-white">
      {/* CTA band */}
      <div className="border-b border-white/10">
        <div className="max-w-[1440px] mx-auto px-6 md:px-10 py-16 md:py-20 flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
          <div>
            <div className="flex items-center gap-5 mb-5">
              <span className="w-8 h-px bg-white/25" />
              <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-white/45">
                Reserve agora
              </span>
            </div>
            <h2 className="font-heading text-3xl md:text-4xl font-semibold text-white leading-[1] tracking-tight max-w-[18ch]">
              Garanta sua estadia em Taíba
            </h2>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 shrink-0">
            <a
              href="#quartos"
              onClick={(e) => {
                e.preventDefault();
                goToRooms();
              }}
              className="inline-flex items-center justify-center gap-2 bg-terracota-text hover:brightness-110 text-offwhite font-body font-semibold text-[11px] uppercase tracking-[0.12em] px-7 py-3.5 rounded-full transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              Reservar
            </a>
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackEvent("whatsapp-duvida")}
              className="inline-flex items-center justify-center gap-2 border border-white/25 text-white hover:bg-white/8 font-body font-medium text-[11px] uppercase tracking-[0.12em] px-7 py-3.5 rounded-full transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <MdWhatsapp size={14} />
              Tirar dúvidas pelo WhatsApp
            </a>
          </div>
        </div>
      </div>

      {/* Footer columns */}
      <div className="max-w-[1440px] mx-auto px-6 md:px-10 py-14 md:py-18 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10 lg:gap-12">
        {/* Brand */}
        <div className="sm:col-span-2 lg:col-span-1">
          <a href="#hero" className="flex flex-col leading-none mb-4">
            <span className="font-heading font-bold text-sm tracking-[0.2em] uppercase text-white">
              Catavento
            </span>
            <span className="font-body font-light text-[9px] tracking-[0.3em] uppercase text-white/40 mt-0.5">
              Pousada
            </span>
          </a>
          <p className="font-body text-sm leading-[1.7] text-white/50 max-w-[28ch]">
            Seu refúgio em Taíba. Conforto, natureza e a hospitalidade que você merece.
          </p>
          <a
            href={INSTAGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackEvent("click_instagram")}
            className="inline-flex items-center gap-2 mt-6 text-white/40 hover:text-white transition-colors text-sm font-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white rounded"
          >
            <FaInstagram size={16} />
            @cataventotaiba
          </a>
        </div>

        {/* Navigation */}
        <div>
          <h3 className="font-body text-[10px] font-semibold uppercase tracking-[0.25em] text-white/40 mb-5">
            Navegação
          </h3>
          <ul className="flex flex-col gap-3">
            {NAV_ITEMS.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className="font-body text-sm text-white/60 hover:text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white rounded"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </div>

        {/* Contact */}
        <div>
          <h3 className="font-body text-[10px] font-semibold uppercase tracking-[0.25em] text-white/40 mb-5">
            Contato
          </h3>
          <ul className="flex flex-col gap-4">
            <li>
              <a
                href={WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => trackEvent("whatsapp-falar")}
                className="inline-flex items-center gap-2.5 font-body text-sm text-white/60 hover:text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white rounded"
              >
                <MdWhatsapp size={16} />
                Falar no WhatsApp
              </a>
            </li>
            <li>
              <a
                href={`tel:+${WHATSAPP_NUMBER}`}
                className="inline-flex items-center gap-2.5 font-body text-sm text-white/60 hover:text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white rounded"
              >
                <MdPhone size={15} />
                {PHONE_DISPLAY}
              </a>
            </li>
          </ul>
        </div>

        {/* Address */}
        <div>
          <h3 className="font-body text-[10px] font-semibold uppercase tracking-[0.25em] text-white/40 mb-5">
            Localização
          </h3>
          <a
            href={MAPS_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackEvent("click_google_maps")}
            className="inline-flex items-start gap-2.5 font-body text-sm text-white/60 hover:text-white transition-colors leading-[1.6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white rounded"
          >
            <MdLocationOn size={15} className="mt-0.5 shrink-0" />
            R. Francisca Ferreira Martins, 1121<br />
            Taíba — CE, Brasil
          </a>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="border-t border-white/8 max-w-[1440px] mx-auto px-6 md:px-10 py-5 flex flex-col sm:flex-row items-center justify-between gap-3 text-[11px] font-body text-white/30">
        <span>&copy; {new Date().getFullYear()} Pousada Catavento. Todos os direitos reservados.</span>
        <span>Taíba, Ceará · Brasil</span>
      </div>
    </footer>
  );
}
