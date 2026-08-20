/*
 * Galeria "Pousada" com pestanas por categoria (fusao do antigo bloco
 * Experiencias: mesmo layout de abas + imagem/texto). Categorias seguem as
 * pastas reais de fotos: Café da Manhã, Piscina, A Pé, Espaços.
 * Quartos e o guia de Taíba (kite/paisaje) vivem em outras seções.
 * Cada aba mostra um carrossel proprio.
 */
import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { MdCottage, MdPool, MdFreeBreakfast, MdDirectionsWalk, MdLandscape } from "react-icons/md";
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
      { src: assetPath("images/exterior/exterior5.webp"), alt: "Catavento no telhado da pousada contra o céu azul", fit: "cover" },
      { src: assetPath("images/exterior/exterior1.webp"), alt: "Placas de madeira indicando os quartos e o café da manhã, cercadas por plantas", fit: "cover" },
      { src: assetPath("images/exterior/exterior2.webp"), alt: "Corredor coberto entre os quartos, com colunas brancas e cortina de bambu", fit: "cover" },
      { src: assetPath("images/exterior/exterior3.webp"), alt: "Corredor entre os quartos com painel de bambu na parede", fit: "cover" },
      { src: assetPath("images/exterior/exterior6.webp"), alt: "Prancha decorativa e placa do quarto sob o teto de palha", fit: "cover" },
      { src: assetPath("images/exterior/exterior7.webp"), alt: "Fachada dos quartos com teto de palha e placa indicando a piscina", fit: "cover" },
      { src: assetPath("images/exterior/exterior8.webp"), alt: "Corredor superior com vista para os telhados da pousada e coqueiros", fit: "cover" },
      { src: assetPath("images/exterior/exterior9.webp"), alt: "Pia externa cercada por trepadeiras floridas e coqueiros", fit: "cover" },
      { src: assetPath("images/exterior/exterior4.webp"), alt: "Entrada iluminada à noite, com luzes de fada e mesa de jantar ao fundo", fit: "cover" },
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
      { src: assetPath("images/desayuno/desayuno2.webp"), alt: "Mesa farta do café da manhã, com frutas, pão de queijo, bolo caseiro e pão francês", fit: "cover" },
      { src: assetPath("images/desayuno/desayuno1.webp"), alt: "Hóspede tomando café da manhã na varanda, com pão de queijo, bolo e frutas frescas", fit: "cover" },
      { src: assetPath("images/desayuno/desayuno8.webp"), alt: "Pão de queijo, bolo caseiro e frutas decorados com flores", fit: "cover" },
      { src: assetPath("images/desayuno/desayuno6.webp"), alt: "Tapioca e prato de frutas frescas vistos de cima", fit: "cover" },
      { src: assetPath("images/desayuno/desayuno7.webp"), alt: "Detalhe da tapioca dourada com recheio de queijo", fit: "cover" },
      { src: assetPath("images/desayuno/desayuno5.webp"), alt: "Tapioca recheada servida em prato individual", fit: "cover" },
      { src: assetPath("images/desayuno/desayuno3.webp"), alt: "Cestas de pão cobertas por redomas de palha no balcão do café da manhã", fit: "cover" },
      { src: assetPath("images/desayuno/desayuno4.webp"), alt: "Potes de açúcar, adoçante e mel ao lado dos copos no balcão", fit: "cover" },
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
      { src: assetPath("images/pileta/pileta5.webp"), alt: "Piscina com pergolado de madeira e cadeira de balanço em rattan", fit: "cover" },
      { src: assetPath("images/pileta/pileta2.webp"), alt: "Área da piscina com pergolado, rede e espreguiçadeiras", fit: "cover" },
      { src: assetPath("images/pileta/pileta1.webp"), alt: "Hóspede relaxando na piscina da pousada", fit: "cover" },
      { src: assetPath("images/pileta/pileta3.webp"), alt: "Hóspede sentada na borda da piscina, com coqueiros ao fundo", fit: "cover" },
      { src: assetPath("images/pileta/pileta4.webp"), alt: "Hóspede relaxando em espreguiçadeira ao lado da piscina", fit: "cover" },
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
      { src: assetPath("images/beco/beco1.webp"), alt: "Beco do Surf iluminado à noite, com bandeirinhas e mesas ao ar livre", fit: "cover" },
      { src: assetPath("images/beco/beco3.webp"), alt: "Movimento de famílias nas mesas do Beco do Surf, com playground iluminado", fit: "cover" },
      { src: assetPath("images/beco/beco2.webp"), alt: "Barraca de comida no Beco do Surf, com a cozinheira preparando os pedidos", fit: "cover" },
    ] satisfies CarouselImage[],
  },
  {
    id: "paisaje",
    icon: MdLandscape,
    label: "Paisagens",
    titleMain: "Paisagens que",
    titleAccent: "ficam na memória",
    description:
      "Falésias, coqueirais e o mar mudando de cor ao longo do dia. Taíba é desses lugares que rendem a melhor foto da viagem sem nem precisar procurar.",
    images: [
      { src: assetPath("images/paisaje/paisaje6.webp"), alt: "Falésia dourada ao entardecer, com coqueiros e casario ao fundo", fit: "cover" },
      { src: assetPath("images/paisaje/paisaje3.webp"), alt: "Coqueiro emoldurando o mar azul-turquesa de Taíba", fit: "cover" },
      { src: assetPath("images/paisaje/paisaje5.webp"), alt: "Coqueiros à beira-mar com águas turquesa e pedras na areia", fit: "cover" },
      { src: assetPath("images/paisaje/paisaje4.webp"), alt: "Falésia coberta de coqueiros em uma enseada com ondas quebrando", fit: "cover" },
      { src: assetPath("images/paisaje/paisaje7.webp"), alt: "Vista da falésia e da vila de Taíba ao entardecer", fit: "cover" },
      { src: assetPath("images/paisaje/paisaje2.webp"), alt: "Pôr do sol na praia de Taíba, com barco de pesca à beira-mar", fit: "cover" },
      { src: assetPath("images/paisaje/paisaje1.webp"), alt: "Pipa de kitesurf sobre a lagoa ao pôr do sol, com kitesurfista na água", fit: "cover" },
    ] satisfies CarouselImage[],
  },
] as const;

export default function Gallery() {
  const [active, setActive] = useState<string>("exterior");
  const reduce = useReducedMotion();

  const current = CATEGORIES.find((c) => c.id === active) ?? CATEGORIES[0];

  return (
    <section id="galeria" className="relative py-24 md:py-36 bg-offwhite overflow-hidden">
      <div className="max-w-[1440px] mx-auto px-6 md:px-10">
        {/* Section header */}
        <div>
          <div className="flex items-center gap-5 mb-5">
            <span className="w-12 h-px bg-rule" />
            <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-terracota-text">
              Galeria
            </span>
          </div>
          <h2 className="font-heading text-4xl md:text-5xl font-semibold text-madera leading-[0.98] tracking-tight">
            Pousada
          </h2>
        </div>

        {/* Tab selector */}
        <div className="mt-10 flex flex-wrap gap-2">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setActive(cat.id)}
              aria-pressed={active === cat.id}
              className={`inline-flex items-center gap-2 px-5 py-2.5 font-body text-[11px] font-semibold uppercase tracking-[0.12em] rounded-full transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracota ${
                active === cat.id
                  ? "bg-madera text-offwhite"
                  : "border border-rule text-ink/70 hover:border-madera/40 hover:text-madera"
              }`}
            >
              <cat.icon size={13} />
              {cat.label}
            </button>
          ))}
        </div>

        {/* Content — mesmo grid de 2 colunas e bloco de acento do About.tsx */}
        <div className="mt-12 grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-24 items-start">
          {/* Imagem */}
          <div className="relative min-w-0">
            <Carousel
              key={current.id}
              images={current.images}
              className="w-full h-full object-contain"
              wrapperClassName="h-[420px] md:h-[620px] max-w-[600px] mx-auto rounded-sm bg-pill"
            />
            {/* Accent block */}
            <div className="absolute -bottom-8 -right-8 w-40 h-40 bg-pill -z-10" />
          </div>

          {/* Texto */}
          <div>
            <AnimatePresence mode="wait">
              <motion.div
                key={current.id}
                initial={reduce ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: -6 }}
                transition={{ duration: 0.3 }}
              >
                <div className="flex items-center gap-5 mb-8">
                  <span className="w-12 h-px bg-rule" />
                  <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-terracota-text">
                    {current.label}
                  </span>
                </div>
                <h3 className="font-heading text-3xl md:text-4xl font-semibold text-madera leading-[0.98] tracking-tight">
                  {current.titleMain}<br />
                  <span className="text-terracota">{current.titleAccent}</span>
                </h3>
                <p className="mt-7 font-body text-base leading-[1.75] text-ink/85 max-w-[52ch]">
                  {current.description}
                </p>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
}
