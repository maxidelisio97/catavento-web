import type { ImgHTMLAttributes } from "react";
import { motion, useReducedMotion } from "motion/react";
import { EASE } from "../lib/motion";
import { cn } from "../lib/utils";

type RevealImageProps = Pick<
  ImgHTMLAttributes<HTMLImageElement>,
  "alt" | "className" | "decoding" | "fetchPriority" | "height" | "loading" | "sizes" | "src" | "srcSet" | "width"
> & {
  wrapperClassName?: string;
  delay?: number;
  amount?: number;
};

const ease = EASE;

export default function RevealImage({
  wrapperClassName,
  className,
  delay = 0,
  amount = 0.2,
  ...props
}: RevealImageProps) {
  const reduce = useReducedMotion();

  return (
    <motion.div
      className={cn("overflow-hidden", wrapperClassName)}
      initial={reduce ? false : { y: 20 }}
      whileInView={reduce ? undefined : { y: 0 }}
      viewport={{ once: true, amount }}
      transition={{ duration: 0.65, delay, ease }}
    >
      <motion.img
        {...props}
        className={className}
        initial={reduce ? false : { scale: 1.05 }}
        whileInView={reduce ? undefined : { scale: 1 }}
        viewport={{ once: true, amount }}
        transition={{ duration: 0.9, delay, ease }}
      />
    </motion.div>
  );
}
