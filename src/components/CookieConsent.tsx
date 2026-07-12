/*
 * Barra de consentimiento de cookies (LGPD), minima y no bloqueante.
 * No es un modal: el scrim de fondo es solo visual (pointer-events-none),
 * el usuario puede seguir navegando y clickeando debajo sin decidir.
 * La eleccion se persiste en localStorage y actualiza el Consent Mode de Google.
 */
import { useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import CataventoIcon from "./CataventoIcon";

const STORAGE_KEY = "cookie-consent";

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

function updateConsent(granted: boolean) {
  window.dataLayer = window.dataLayer || [];
  function gtag(...args: unknown[]) {
    window.dataLayer!.push(args);
  }
  gtag("consent", "update", {
    analytics_storage: granted ? "granted" : "denied",
  });
}

export default function CookieConsent() {
  const [visible, setVisible] = useState(false);
  const reduce = useReducedMotion();

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "granted") {
      updateConsent(true);
    } else if (stored === null) {
      const timer = setTimeout(() => setVisible(true), 2500);
      return () => clearTimeout(timer);
    }
  }, []);

  function handleChoice(granted: boolean) {
    localStorage.setItem(STORAGE_KEY, granted ? "granted" : "denied");
    updateConsent(granted);
    setVisible(false);
  }

  return (
    <AnimatePresence>
      {visible && (
        <>
          <motion.div
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-warm-900 pointer-events-none"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 0.35 }}
            exit={reduce ? undefined : { opacity: 0 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
          />
          <motion.div
            role="region"
            aria-label="Consentimento de cookies"
            className="fixed bottom-4 left-4 z-50 max-w-sm"
            initial={reduce ? false : { opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: 20 }}
            transition={{ duration: 0.7, ease: "easeOut" }}
          >
            <div className="flex flex-col gap-4 rounded-2xl border border-stone-200 bg-white p-5 shadow-xl shadow-warm-900/20">
              <div className="flex items-start gap-3">
                <CataventoIcon height={22} color="var(--color-coral-600)" className="shrink-0 mt-0.5" />
                <p className="text-sm text-stone-500">
                  Aceitando cookies, você nos ajuda a melhorar a experiência
                  da pousada.
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => handleChoice(false)}
                  className="rounded-full px-4 py-2 text-sm text-stone-500 hover:text-warm-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-500"
                >
                  Recusar
                </button>
                <button
                  type="button"
                  onClick={() => handleChoice(true)}
                  className="rounded-full bg-coral-600 px-4 py-2 text-sm text-white hover:bg-coral-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-500"
                >
                  Aceitar
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
