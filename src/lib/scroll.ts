/*
 * Scroll suave con duracion propia (el smooth scroll nativo del navegador
 * no permite controlar la velocidad). Respeta scroll-margin-top del
 * elemento destino (compensa el header fijo) y prefers-reduced-motion.
 *
 * behavior: "instant" es obligatorio en cada scrollTo: el sitio tiene
 * `scroll-behavior: smooth` global en CSS (para los links de nav comunes).
 * Sin este override, el navegador le aplica SU propio smooth-scroll a
 * cada llamada del loop, que compite con este easing manual y termina
 * bloqueando los frames hasta soltar todo de golpe en vez de animar.
 */
function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function smoothScrollTo(id: string, duration = 900) {
  const el = document.getElementById(id);
  if (!el) return;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scrollMarginTop = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  const startY = window.scrollY;
  const targetY = el.getBoundingClientRect().top + startY - scrollMarginTop;

  if (reduce) {
    window.scrollTo({ top: targetY, behavior: "instant" });
    return;
  }

  const distance = targetY - startY;
  const startTime = performance.now();

  function step(now: number) {
    const progress = Math.min((now - startTime) / duration, 1);
    window.scrollTo({ top: startY + distance * easeInOutCubic(progress), behavior: "instant" });
    if (progress < 1) requestAnimationFrame(step);
  }

  requestAnimationFrame(step);
}

/*
 * Atajo compartido por el header y el CTA flotante: scroll suave a los
 * quartos (punto de entrada real a la reserva, via las cards + modal).
 */
export function goToRooms() {
  smoothScrollTo("quartos");
}
