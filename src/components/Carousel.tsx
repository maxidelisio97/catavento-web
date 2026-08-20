/*
 * Carrossel simples para fotos de uma unica habitacao/seccion.
 * Flechas + dots, swipe en mobile, sin autoplay. Si solo hay una foto,
 * flechas y dots no se muestran (no tiene sentido un carrusel de 1).
 */
import { useRef, useState, type TouchEvent } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { MdChevronLeft, MdChevronRight } from "react-icons/md";
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

const SWIPE_THRESHOLD = 40;

// Slide horizontal tipo Instagram: a foto que entra vem do lado para onde se
// navega, a que sai vai para o lado oposto — as duas se movem ao mesmo tempo
// (por isso o <img> e absolute inset-0, empilhado sobre o anterior).
const slideVariants = {
  enter: (dir: number) => ({ x: dir > 0 ? "100%" : "-100%", opacity: 1 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? "-100%" : "100%", opacity: 1 }),
};

const staticVariants = {
  enter: { opacity: 1 },
  center: { opacity: 1 },
  exit: { opacity: 1 },
};

export default function Carousel({ images, className, wrapperClassName, delay = 0, amount = 0.2 }: CarouselProps) {
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(0);
  const reduce = useReducedMotion();
  const touchStartX = useRef<number | null>(null);
  const hasMultiple = images.length > 1;

  function goDelta(delta: number) {
    setDirection(delta);
    setIndex((prev) => (prev + delta + images.length) % images.length);
  }

  function goTo(next: number) {
    if (next === index) return;
    setDirection(next > index ? 1 : -1);
    setIndex(next);
  }

  function handleTouchStart(e: TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }

  function handleTouchEnd(e: TouchEvent) {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(delta) > SWIPE_THRESHOLD) goDelta(delta < 0 ? 1 : -1);
    touchStartX.current = null;
  }

  // delay/amount ficam na API so por compatibilidade com os call sites
  // existentes — sem reveal on-scroll, nao tem mais nada pra fazer com eles.
  void delay;
  void amount;

  return (
    <div
      className={cn("relative overflow-hidden", wrapperClassName)}
      onTouchStart={hasMultiple ? handleTouchStart : undefined}
      onTouchEnd={hasMultiple ? handleTouchEnd : undefined}
    >
      <AnimatePresence initial={false} custom={direction}>
        <motion.img
          key={images[index].src}
          src={images[index].src}
          alt={images[index].alt}
          loading="lazy"
          className={cn("absolute inset-0", className)}
          style={{
            objectPosition: images[index].position ?? "center",
            ...(images[index].fit ? { objectFit: images[index].fit } : {}),
          }}
          custom={direction}
          variants={reduce ? staticVariants : slideVariants}
          initial={reduce ? false : "enter"}
          animate="center"
          exit="exit"
          transition={reduce ? { duration: 0 } : { duration: 0.4, ease: "easeInOut" }}
        />
      </AnimatePresence>

      {hasMultiple && (
        <>
          <button
            type="button"
            aria-label="Foto anterior"
            onClick={() => goDelta(-1)}
            className="absolute left-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-11 h-11 rounded-full bg-madera/40 hover:bg-madera/60 text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <MdChevronLeft size={20} />
          </button>
          <button
            type="button"
            aria-label="Próxima foto"
            onClick={() => goDelta(1)}
            className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-11 h-11 rounded-full bg-madera/40 hover:bg-madera/60 text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
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
                onClick={() => goTo(i)}
                className={cn(
                  "h-1.5 rounded-full bg-white/50 transition-all",
                  i === index ? "w-4 bg-white" : "w-1.5"
                )}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
