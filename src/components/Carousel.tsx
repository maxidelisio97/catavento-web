/*
 * Carrossel simples para fotos de uma unica habitacao/seccion.
 * Flechas + dots, swipe en mobile, sin autoplay. Si solo hay una foto,
 * flechas y dots no se muestran (no tiene sentido un carrusel de 1).
 */
import { useRef, useState, type TouchEvent } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { MdChevronLeft, MdChevronRight } from "react-icons/md";
import { EASE } from "../lib/motion";
import { cn } from "../lib/utils";

// position: ajuste manual de object-position para fotos cujo enquadramento
// original nao centra o assunto (ex.: moveis altos e estreitos, cortados pela
// metade num wrapper 4/3). Default "center" cobre o caso comum.
// fit: "cover" para fotos ja recortadas na proporcao do wrapper (preenche
// sem sobra); "contain" (default) mostra a foto inteira, com faixas vazias
// nas fotos que ainda nao foram recortadas na proporcao certa.
export type CarouselImage = { src: string; alt: string; position?: string; fit?: "cover" | "contain" };

type CarouselProps = {
  images: readonly CarouselImage[];
  className?: string;
  wrapperClassName?: string;
  delay?: number;
  amount?: number;
};

const ease = EASE;
const SWIPE_THRESHOLD = 40;

export default function Carousel({ images, className, wrapperClassName, delay = 0, amount = 0.2 }: CarouselProps) {
  const [index, setIndex] = useState(0);
  const reduce = useReducedMotion();
  const touchStartX = useRef<number | null>(null);
  const hasMultiple = images.length > 1;

  function go(next: number) {
    setIndex((next + images.length) % images.length);
  }

  function handleTouchStart(e: TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }

  function handleTouchEnd(e: TouchEvent) {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(delta) > SWIPE_THRESHOLD) go(index + (delta < 0 ? 1 : -1));
    touchStartX.current = null;
  }

  return (
    <motion.div
      className={cn("relative overflow-hidden", wrapperClassName)}
      initial={reduce ? false : { y: 20 }}
      whileInView={reduce ? undefined : { y: 0 }}
      viewport={{ once: true, amount }}
      transition={{ duration: 0.65, delay, ease }}
      onTouchStart={hasMultiple ? handleTouchStart : undefined}
      onTouchEnd={hasMultiple ? handleTouchEnd : undefined}
    >
      <AnimatePresence initial={false} mode="wait">
        <motion.img
          key={images[index].src}
          src={images[index].src}
          alt={images[index].alt}
          loading="lazy"
          className={className}
          style={{
            objectPosition: images[index].position ?? "center",
            ...(images[index].fit ? { objectFit: images[index].fit } : {}),
          }}
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduce ? undefined : { opacity: 0 }}
          transition={{ duration: 0.35, ease }}
        />
      </AnimatePresence>

      {hasMultiple && (
        <>
          <button
            type="button"
            aria-label="Foto anterior"
            onClick={() => go(index - 1)}
            className="absolute left-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-8 h-8 rounded-full bg-warm-900/40 hover:bg-warm-900/60 text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <MdChevronLeft size={20} />
          </button>
          <button
            type="button"
            aria-label="Próxima foto"
            onClick={() => go(index + 1)}
            className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-8 h-8 rounded-full bg-warm-900/40 hover:bg-warm-900/60 text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <MdChevronRight size={20} />
          </button>

          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex flex-wrap items-center justify-center gap-1.5 max-w-[85%]">
            {images.map((img, i) => (
              <button
                key={img.src}
                type="button"
                aria-label={`Ir para foto ${i + 1}`}
                aria-current={i === index}
                onClick={() => setIndex(i)}
                className={cn(
                  "h-1.5 rounded-full bg-white/50 transition-all",
                  i === index ? "w-4 bg-white" : "w-1.5"
                )}
              />
            ))}
          </div>
        </>
      )}
    </motion.div>
  );
}
