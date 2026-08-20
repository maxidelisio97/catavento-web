/*
 * Maneja el encabezado fijo del sitio.
 * Contiene logo, navegacion y menu mobile (sin CTA propio — la reserva
 * pasa por las cards de Quartos y su modal).
 * Si necesito modificar el header o sus links, este es el archivo.
 */
import { useState, useEffect } from "react";
import { MdMenu, MdClose, MdKeyboardArrowDown } from "react-icons/md";
import { NAV_ITEMS } from "../config/site";
import CataventoIcon from "./CataventoIcon";


export default function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [roomsInView, setRoomsInView] = useState(true);
  const [navRevealed, setNavRevealed] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // O header desktop se esconde ao passar dos quartos (menos ruido durante
  // a leitura), reaparece na "abinha central" — comportamento independente
  // de qualquer CTA, so decluttering de scroll.
  useEffect(() => {
    const rooms = document.getElementById("quartos");
    if (!rooms) return;

    const roomsObserver = new IntersectionObserver(([entry]) => setRoomsInView(entry.isIntersecting));
    roomsObserver.observe(rooms);

    return () => roomsObserver.disconnect();
  }, []);

  // Reseta o "revelado" manual sempre que os quartos voltam a tela, para
  // que o header volte a esconder da proxima vez que o usuario passar deles.
  useEffect(() => {
    if (roomsInView) setNavRevealed(false);
  }, [roomsInView]);

  const textClass = scrolled ? "text-madera" : "text-duna3";
  const mutedClass = scrolled ? "text-ink/50" : "text-duna3/60";

  // Guarda o menu (desktop) depois que os quartos saem
  // de tela; reaparece ao clicar na abinha central. Mobile fica sempre
  // visivel (o toque nao tem "passar por cima"). Nao respeita
  // prefers-reduced-motion de proposito: e um comportamento funcional (achar
  // a nav), nao um efeito decorativo — decisao 2026-08-01, revisar se o dono
  // preferir outro criterio.
  const headerHidden = !roomsInView && !navRevealed && !open;

  return (
    <>
    {/* Abinha central: só existe enquanto o header está escondido; clicar
        revela a nav (substitui o hover, que não existe em bom número de
        setups desktop com trackpad/touch). */}
    {headerHidden && (
      <button
        type="button"
        onClick={() => setNavRevealed(true)}
        aria-label="Mostrar menu"
        className="hidden md:flex fixed top-0 inset-x-0 mx-auto w-14 h-8 items-center justify-center gap-1 rounded-b-lg bg-offwhite shadow-[0_2px_6px_0_rgba(0,0,0,0.12)] text-madera z-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracota"
      >
        <CataventoIcon height={14} />
        <MdKeyboardArrowDown size={14} aria-hidden />
      </button>
    )}
    <header
      className={`fixed top-0 inset-x-0 z-50 transition-all duration-500 ${
        scrolled ? "bg-offwhite shadow-[0_1px_0_0_var(--color-rule)]" : "bg-transparent"
      } ${headerHidden ? "md:-translate-y-full" : "md:translate-y-0"}`}
    >
      <nav className="max-w-[1440px] mx-auto flex items-center px-6 md:px-10 h-[72px] md:h-20">
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

        {/* Desktop nav: empurrado pra direita (ml-auto), sem CTA — logo
            esquerda / menu direita. */}
        <ul className="hidden md:flex ml-auto items-center gap-10">
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <a
                href={item.href}
                className={`font-body text-sm font-medium tracking-[0.02em] transition-colors duration-200 hover:text-terracota focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracota rounded ${textClass}`}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>

        {/* Mobile toggle */}
        <button
          type="button"
          className={`md:hidden ml-auto flex items-center justify-center w-11 h-11 -mr-2 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracota ${textClass}`}
          onClick={() => setOpen(!open)}
          aria-label={open ? "Fechar menu" : "Abrir menu"}
          aria-expanded={open}
        >
          {open ? <MdClose size={22} /> : <MdMenu size={22} />}
        </button>
      </nav>

      {/* Mobile menu */}
      {open && (
        <div className="md:hidden bg-offwhite border-t border-rule">
          <ul className="flex flex-col px-6 py-5 gap-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className="block py-3 font-body text-sm font-medium text-ink hover:text-terracota-text transition-colors border-b border-rule last:border-0"
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </header>
    </>
  );
}
