/*
 * Maneja el encabezado fijo del sitio.
 * Contiene logo, navegacion, boton de reserva y menu mobile.
 * Si necesito modificar el header o sus links, este es el archivo.
 */
import { useState, useEffect } from "react";
import { MdMenu, MdClose, MdKeyboardArrowDown } from "react-icons/md";
import { LuCalendarCheck } from "react-icons/lu";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { NAV_ITEMS } from "../config/site";
import CataventoIcon from "./CataventoIcon";
import { goToBookingForm } from "../lib/scroll";


export default function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [formInView, setFormInView] = useState(true);
  const [footerInView, setFooterInView] = useState(false);
  const [navRevealed, setNavRevealed] = useState(false);
  const reduce = useReducedMotion();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // El CTA "Reservar" del header desktop solo aparece una vez que el
  // formulario real deja de estar en pantalla, y se oculta de nuevo
  // cerca del footer (que ya tiene sus propios CTA de reserva).
  useEffect(() => {
    const form = document.getElementById("booking-form");
    const footer = document.getElementById("reservar");
    if (!form || !footer) return;

    const formObserver = new IntersectionObserver(([entry]) => setFormInView(entry.isIntersecting));
    const footerObserver = new IntersectionObserver(([entry]) => setFooterInView(entry.isIntersecting));
    formObserver.observe(form);
    footerObserver.observe(footer);

    return () => {
      formObserver.disconnect();
      footerObserver.disconnect();
    };
  }, []);

  // Reseta o "revelado" manual sempre que o formulario volta a tela, para
  // que o header volte a esconder da proxima vez que o usuario passar dele.
  useEffect(() => {
    if (formInView) setNavRevealed(false);
  }, [formInView]);

  const showReserveCta = !formInView && !footerInView;
  const textClass = scrolled ? "text-warm-900" : "text-white";
  const mutedClass = scrolled ? "text-warm-800/50" : "text-white/60";

  // Guarda o menu (desktop) depois que o formulario de disponibilidade sai
  // de tela; reaparece ao clicar na abinha central. Mobile fica sempre
  // visivel (o toque nao tem "passar por cima"). Nao respeita
  // prefers-reduced-motion de proposito: e um comportamento funcional (achar
  // a nav), nao um efeito decorativo — decisao 2026-08-01, revisar se o dono
  // preferir outro criterio.
  const headerHidden = !formInView && !navRevealed && !open;

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
        className="hidden md:flex fixed top-0 inset-x-0 mx-auto w-14 h-8 items-center justify-center gap-1 rounded-b-lg bg-white shadow-[0_2px_6px_0_rgba(0,0,0,0.12)] text-warm-900 z-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-500"
      >
        <CataventoIcon height={14} />
        <MdKeyboardArrowDown size={14} aria-hidden />
      </button>
    )}
    <header
      className={`fixed top-0 inset-x-0 z-50 transition-all duration-500 ${
        scrolled ? "bg-white shadow-[0_1px_0_0_oklch(88%_0.022_70)]" : "bg-transparent"
      } ${headerHidden ? "md:-translate-y-full" : "md:translate-y-0"}`}
    >
      <nav className="max-w-[1440px] mx-auto flex md:grid md:grid-cols-3 items-center justify-between px-6 md:px-10 h-[72px] md:h-20">
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

        {/* Desktop nav: justify-self-center (no md:justify-between del pai)
            centraliza este bloco na coluna do meio, independente da largura
            do logo a esquerda e do toggle (vazio em desktop) a direita. */}
        <ul className="hidden md:flex md:justify-self-center items-center gap-10">
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

        {/* CTA (aparece con fade-in al pasar el formulario, desktop y mobile) + toggle */}
        <div className="flex items-center justify-end md:justify-self-end gap-2 md:gap-3">
          <AnimatePresence>
            {showReserveCta && (
              <motion.a
                href="#booking-form"
                aria-label="Reservar"
                onClick={(e) => {
                  e.preventDefault();
                  goToBookingForm();
                }}
                className="flex items-center justify-center gap-1.5 font-body text-sm font-semibold tracking-[0.02em] w-10 h-10 md:w-auto md:h-auto md:px-5 md:py-2.5 rounded-full bg-coral-600 hover:bg-coral-500 text-white transition-colors duration-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-400"
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduce ? undefined : { opacity: 0 }}
                transition={{ duration: 0.3 }}
              >
                <LuCalendarCheck size={18} className="md:hidden" aria-hidden />
                <LuCalendarCheck size={16} className="hidden md:block" aria-hidden />
                <span className="hidden md:inline">Reservar</span>
              </motion.a>
            )}
          </AnimatePresence>

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
          </ul>
        </div>
      )}
    </header>
    </>
  );
}
