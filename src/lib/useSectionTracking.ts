/*
 * Trackea scroll_seccion via IntersectionObserver: una sola vez por seccion
 * por sesion de navegador (persistido en sessionStorage, sobrevive a un
 * reload dentro de la misma pestana/sesion).
 */
import { useEffect } from "react";
import { trackEvent } from "./analytics";

const STORAGE_KEY = "ga-scroll-seccion-seen";
const SECTION_IDS = ["hero", "experiencias", "quartos", "depoimentos", "taiba", "reservar"];

function readSeen(): Set<string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function markSeen(seen: Set<string>) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...seen]));
  } catch {
    // sessionStorage indisponivel (modo privado, etc.) — sem persistencia entre reloads
  }
}

export function useSectionTracking() {
  useEffect(() => {
    const seen = readSeen();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = entry.target.id;
          if (seen.has(id)) continue;
          seen.add(id);
          markSeen(seen);
          trackEvent("scroll_seccion", { seccion: id });
        }
      },
      { threshold: 0.3 }
    );

    const elements = SECTION_IDS.map((id) => document.getElementById(id)).filter(
      (el): el is HTMLElement => el !== null
    );
    elements.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, []);
}
