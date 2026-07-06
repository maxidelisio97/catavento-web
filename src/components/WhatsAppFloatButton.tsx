/*
 * Boton flotante de WhatsApp, solo mobile.
 * Aparece cuando el usuario scrollea mas alla del hero, nunca antes.
 */
import { useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { MdWhatsapp } from "react-icons/md";
import { WHATSAPP_URL } from "../config/site";

export default function WhatsAppFloatButton() {
  const [visible, setVisible] = useState(false);
  const reduce = useReducedMotion();

  useEffect(() => {
    const hero = document.getElementById("hero");
    if (!hero) return;

    const observer = new IntersectionObserver(([entry]) => {
      setVisible(!entry.isIntersecting);
    });
    observer.observe(hero);

    return () => observer.disconnect();
  }, []);

  return (
    <AnimatePresence>
      {visible && (
        <motion.a
          href={WHATSAPP_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Dúvidas? Fale conosco"
          className="md:hidden fixed bottom-5 right-5 z-40 flex items-center justify-center w-14 h-14 rounded-full bg-coral-600 text-white shadow-lg shadow-warm-900/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-500"
          initial={reduce ? false : { opacity: 0, scale: 0.7, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduce ? undefined : { opacity: 0, scale: 0.7, y: 12 }}
          transition={{ duration: 0.25 }}
        >
          <MdWhatsapp size={26} />
        </motion.a>
      )}
    </AnimatePresence>
  );
}
