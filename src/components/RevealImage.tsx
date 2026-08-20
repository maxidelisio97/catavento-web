import type { ImgHTMLAttributes } from "react";
import { cn } from "../lib/utils";

type RevealImageProps = Pick<
  ImgHTMLAttributes<HTMLImageElement>,
  "alt" | "className" | "decoding" | "fetchPriority" | "height" | "loading" | "sizes" | "src" | "srcSet" | "width"
> & {
  wrapperClassName?: string;
  delay?: number;
  amount?: number;
};

// Passthrough estático: mantém a API (wrapperClassName/delay/amount) para não
// quebrar call sites, mas sem motion — a imagem aparece no lugar, sem reveal.
export default function RevealImage({
  wrapperClassName,
  className,
  delay,
  amount,
  ...props
}: RevealImageProps) {
  // delay/amount ficam na API so por compatibilidade com os call sites
  // existentes (nao quebrar quem ja passa essas props) — sem motion, nao
  // tem mais nada pra fazer com eles.
  void delay;
  void amount;

  return (
    <div className={cn("overflow-hidden", wrapperClassName)}>
      <img {...props} className={className} />
    </div>
  );
}
