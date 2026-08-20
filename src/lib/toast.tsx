/*
 * Toast minimo, una sola instancia global montada en App. Se dispara
 * desde cualquier componente via useToast().show(mensaje) y se
 * autodescarta solo despues de unos segundos.
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

type ToastContextValue = { show: (message: string) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timeoutRef = useRef<number | undefined>(undefined);
  const reduce = useReducedMotion();

  const show = useCallback((msg: string) => {
    setMessage(msg);
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setMessage(null), 2600);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <AnimatePresence>
        {message && (
          <motion.div
            role="status"
            className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 px-5 py-3 rounded-full bg-madera text-offwhite font-body text-sm text-center shadow-lg shadow-madera/25 max-w-[90vw]"
            initial={reduce ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: 10 }}
            transition={{ duration: 0.25 }}
          >
            {message}
          </motion.div>
        )}
      </AnimatePresence>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast debe usarse dentro de ToastProvider");
  return ctx;
}
