/*
 * Galeria "Pousada" com pestanas por categoria (fusao do antigo bloco
 * Experiencias: mesmo layout de abas + imagem/texto). Categorias seguem as
 * pastas reais de fotos: Café da Manhã, Piscina, A Pé, Espaços.
 * Quartos e o guia de Taíba (kite/paisaje) vivem em outras seções.
 * Cada aba mostra um carrossel proprio.
 */
import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { MdCottage, MdPool, MdFreeBreakfast, MdDirectionsWalk } from "react-icons/md";
import { EASE } from "../lib/motion";
import { assetPath } from "../config/site";
import Carousel, { type CarouselImage } from "./Carousel";

const CATEGORIES = [
  {
    id: "exterior",
    icon: MdCottage,
    label: "Espaços",
    titleMain: "Cada canto conta um pouco",
    titleAccent: "do Catavento",
    description:
      "O jardim, a varanda, o catavento no telhado — a pousada é feita de detalhes simples que convidam a desacelerar. Estes registros são o dia a dia real de quem se hospeda aqui.",
    images: [
      { src: assetPath("images/exterior/exterior2.webp"), alt: "Gramado e varanda com teto de palha, coqueiro ao centro", fit: "cover" },
      { src: assetPath("images/exterior/exterior3.webp"), alt: "Varanda com teto de palha entre as plantas", fit: "cover" },
      { src: assetPath("images/exterior/exterior4.webp"), alt: "Corredor entre os quartos com cortina de bambu", fit: "cover" },
      { src: assetPath("images/exterior/exterior6.webp"), alt: "Corredor externo entre a fachada e a varanda com teto de palha", fit: "cover" },
      { src: assetPath("images/exterior/exterior7.webp"), alt: "Varanda com teto de palha e catavento no telhado ao fundo", fit: "cover" },
      { src: assetPath("images/exterior/exterior8.webp"), alt: "Entrada iluminada à noite, com mesa de jantar ao fundo", fit: "cover" },
      { src: assetPath("images/exterior/exterior9.webp"), alt: "Fachada da pousada com coqueiro e garagem coberta", fit: "cover" },
      { src: assetPath("images/exterior/exterior10.webp"), alt: "Caminho florido até a piscina, com o catavento ao fundo", fit: "cover" },
      { src: assetPath("images/exterior/exterior11.webp"), alt: "Vista aérea dos telhados da pousada com o catavento", fit: "cover" },
      { src: assetPath("images/exterior/exterior12.webp"), alt: "Placas de madeira indicando os quartos e o café da manhã", fit: "cover" },
      { src: assetPath("images/dron.webp"), alt: "Vista aérea da pousada, piscina e o mar de Taíba" },
    ] satisfies CarouselImage[],
  },
  {
    id: "cafe",
    icon: MdFreeBreakfast,
    label: "Café da Manhã",
    titleMain: "O café que começa",
    titleAccent: "bem o dia",
    description:
      "Pães, frios, bolos caseiros e frutas frescas servidos com calma antes de sair para o mar ou para explorar Taíba — parte da experiência, não só uma refeição.",
    images: [
      { src: assetPath("images/desayuno/desayuno.webp"), alt: "Fatias de manga fresca servidas no café da manhã", fit: "cover" },
      { src: assetPath("images/desayuno/desayuno1.webp"), alt: "Pão de queijo servido no café da manhã", fit: "cover" },
      { src: assetPath("images/desayuno/desayuno2.webp"), alt: "Bolo caseiro fatiado no café da manhã", fit: "cover" },
      { src: assetPath("images/desayuno/desayuno3.webp"), alt: "Salão do café da manhã com prancha decorativa no teto", fit: "cover" },
      { src: assetPath("images/desayuno/desayuno4.webp"), alt: "Pães variados servidos na cesta do café da manhã", fit: "cover" },
      { src: assetPath("images/desayuno/desayuno5.webp"), alt: "Detalhe do café da manhã servido à mesa", fit: "cover" },
      { src: assetPath("images/desayuno/desayuno7.webp"), alt: "Frios variados: queijo e presunto servidos no café da manhã", fit: "cover" },
    ] satisfies CarouselImage[],
  },
  {
    id: "pileta",
    icon: MdPool,
    label: "Piscina",
    titleMain: "Piscina e áreas",
    titleAccent: "de convivência",
    description:
      "Um deck para relaxar depois do mar, com a piscina ao ar livre como ponto de encontro do dia. Espaço pensado para desacelerar entre uma sessão de kite e outra.",
    images: [
      { src: assetPath("images/pileta/deck y pileta.webp"), alt: "Deck e piscina da pousada", fit: "cover" },
      { src: assetPath("images/pileta/piscina.webp"), alt: "Vista aérea da piscina da pousada", fit: "cover" },
      { src: assetPath("images/pileta/piscina2.webp"), alt: "Deck coberto ao lado da piscina, com rede e espreguiçadeiras", fit: "cover" },
    ] satisfies CarouselImage[],
  },
  {
    id: "beco",
    icon: MdDirectionsWalk,
    label: "A Pé",
    titleMain: "Tudo perto,",
    titleAccent: "a poucos passos",
    description:
      "Beco do Surf, mirante e praia — tudo a poucos passos da pousada, sem precisar de carro. Ficamos literalmente ao lado do Beco do Surf, o point de comidas, música e encontro de quem vive o kite em Taíba.",
    images: [
      { src: assetPath("images/beco/beco1.webp"), alt: "Barracas do Beco do Surf iluminadas à noite", fit: "cover" },
      { src: assetPath("images/beco/beco2.webp"), alt: "Mesas ao ar livre no Beco do Surf", fit: "cover" },
      { src: assetPath("images/beco/beco3.webp"), alt: "Movimento noturno no Beco do Surf", fit: "cover" },
      { src: assetPath("images/beco/beco4.webp"), alt: "Show de música ao vivo no Beco do Surf", fit: "cover" },
    ] satisfies CarouselImage[],
  },
] as const;

const ease = EASE;

export default function Gallery() {
  const [active, setActive] = useState<string>("exterior");
  const reduce = useReducedMotion();

  const current = CATEGORIES.find((c) => c.id === active) ?? CATEGORIES[0];

  return (
    <section id="galeria" className="relative py-24 md:py-36 bg-white overflow-hidden">
      <div className="max-w-[1440px] mx-auto px-6 md:px-10">
        {/* Section header */}
        <motion.div
          initial={reduce ? false : { y: 16 }}
          whileInView={reduce ? undefined : { y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease }}
        >
          <div className="flex items-center gap-5 mb-5">
            <span className="w-12 h-px bg-sand-300" />
            <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-coral-600">
              Galeria
            </span>
          </div>
          <h2 className="font-heading text-4xl md:text-5xl font-semibold text-warm-900 leading-[0.98] tracking-tight">
            Pousada
          </h2>
        </motion.div>

        {/* Tab selector */}
        <motion.div
          className="mt-10 flex flex-wrap gap-2"
          initial={reduce ? false : { y: 12 }}
          whileInView={reduce ? undefined : { y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.1, ease }}
        >
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setActive(cat.id)}
              aria-pressed={active === cat.id}
              className={`inline-flex items-center gap-2 px-5 py-2.5 font-body text-[11px] font-semibold uppercase tracking-[0.12em] rounded-full transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-500 ${
                active === cat.id
                  ? "bg-warm-900 text-white"
                  : "border border-sand-300 text-warm-800/70 hover:border-warm-900/40 hover:text-warm-900"
              }`}
            >
              <cat.icon size={13} />
              {cat.label}
            </button>
          ))}
        </motion.div>

        {/* Content — mesmo grid de 2 colunas e bloco de acento do About.tsx */}
        <div className="mt-12 grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-24 items-start">
          {/* Imagem */}
          <motion.div
            className="relative min-w-0"
            initial={reduce ? false : { x: -24 }}
            whileInView={reduce ? undefined : { x: 0 }}
            viewport={{ once: true, amount: 0.25 }}
            transition={{ duration: 0.8, ease }}
          >
            <Carousel
              key={current.id}
              images={current.images}
              className="w-full h-full object-contain"
              wrapperClassName="h-[420px] md:h-[620px] max-w-[600px] mx-auto rounded-sm bg-sand-100"
            />
            {/* Accent block */}
            <div className="absolute -bottom-8 -right-8 w-40 h-40 bg-sand-100 -z-10" />
          </motion.div>

          {/* Texto */}
          <motion.div
            initial={reduce ? false : { x: 24 }}
            whileInView={reduce ? undefined : { x: 0 }}
            viewport={{ once: true, amount: 0.25 }}
            transition={{ duration: 0.8, delay: 0.12, ease }}
          >
            <AnimatePresence mode="wait">
              <motion.div
                key={current.id}
                initial={reduce ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: -6 }}
                transition={{ duration: 0.3 }}
              >
                <div className="flex items-center gap-5 mb-8">
                  <span className="w-12 h-px bg-sand-300" />
                  <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-coral-600">
                    {current.label}
                  </span>
                </div>
                <h3 className="font-heading text-3xl md:text-4xl font-semibold text-warm-900 leading-[0.98] tracking-tight">
                  {current.titleMain}<br />
                  <span className="text-coral-500">{current.titleAccent}</span>
                </h3>
                <p className="mt-7 font-body text-base leading-[1.75] text-warm-800/65 max-w-[52ch]">
                  {current.description}
                </p>
              </motion.div>
            </AnimatePresence>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
