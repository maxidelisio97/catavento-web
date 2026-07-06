/*
 * Maneja el encabezado fijo del sitio.
 * Contiene logo, navegacion, boton de reserva y menu mobile.
 * Si necesito modificar el header o sus links, este es el archivo.
 */
import { useState, useEffect } from "react";
import { MdMenu, MdClose } from "react-icons/md";
import { NAV_ITEMS } from "../config/site";
import CataventoIcon from "./CataventoIcon";


export default function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const textClass = scrolled ? "text-warm-900" : "text-white";
  const mutedClass = scrolled ? "text-warm-800/50" : "text-white/60";

  return (
    <header
      className={`fixed top-0 inset-x-0 z-50 transition-all duration-500 ${
        scrolled ? "bg-white shadow-[0_1px_0_0_oklch(88%_0.022_70)]" : "bg-transparent"
      }`}
    >
      <nav className="max-w-[1440px] mx-auto flex items-center justify-between px-6 md:px-10 h-[72px] md:h-20">
        {/* Logo */}
        <a href="#hero" className="flex items-center gap-2.5">
          <CataventoIcon
            height={64}
            className={`header-icon shrink-0 transition-colors duration-300 ${textClass}`}
          />
          <span className="flex flex-col leading-none">
            <span className={`font-heading font-bold text-sm tracking-[0.2em] uppercase transition-colors duration-300 ${textClass}`}>
              Catavento
            </span>
            <span className={`font-body font-light text-[9px] tracking-[0.3em] uppercase transition-colors duration-300 ${mutedClass}`}>
              Pousada
            </span>
          </span>
        </a>

        {/* Desktop nav */}
        <ul className="hidden md:flex items-center gap-10">
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <a
                href={item.href}
                className={`font-body text-sm font-medium tracking-[0.02em] transition-opacity duration-200 hover:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-500 rounded ${textClass}`}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>

        {/* CTA + mobile */}
        <div className="flex items-center gap-3">
          <a
            href="#quartos"
            className={`hidden md:inline-flex items-center font-body text-sm font-semibold tracking-[0.02em] px-5 py-2.5 border rounded-full transition-all duration-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-500 ${
              scrolled
                ? "border-coral-600 text-coral-600 hover:bg-coral-600 hover:text-white"
                : "border-white text-white hover:bg-white hover:text-warm-900"
            }`}
          >
            Reservar
          </a>

          <button
            type="button"
            className={`md:hidden p-2 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-500 ${textClass}`}
            onClick={() => setOpen(!open)}
            aria-label={open ? "Fechar menu" : "Abrir menu"}
            aria-expanded={open}
          >
            {open ? <MdClose size={22} /> : <MdMenu size={22} />}
          </button>
        </div>
      </nav>

      {/* Mobile menu */}
      {open && (
        <div className="md:hidden bg-white border-t border-sand-200">
          <ul className="flex flex-col px-6 py-5 gap-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className="block py-3 font-body text-sm font-medium text-warm-800 hover:text-coral-600 transition-colors border-b border-sand-100 last:border-0"
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </a>
              </li>
            ))}
            <li className="pt-4">
              <a
                href="#quartos"
                className="block text-center bg-coral-600 text-white font-body font-semibold text-sm tracking-[0.02em] py-3 rounded-full"
                onClick={() => setOpen(false)}
              >
                Reservar agora
              </a>
            </li>
          </ul>
        </div>
      )}
    </header>
  );
}
