/*
 * Explica los atractivos de Taiba y muestra datos destacados del destino.
 * Aca debo cambiar beneficios, textos turisticos, fondo o enlace al mapa.
 * Es una seccion informativa, no maneja reservas. Incluye tambien un
 * carrossel de fotos (Kite/Paisagem), mesmo padrao do Gallery.tsx mas
 * com cores adaptadas ao fundo escuro desta seccao.
 */
import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { MdWbSunny, MdAir, MdSurfing, MdLocationOn, MdLandscape } from "react-icons/md";
import { assetPath, MAPS_URL } from "../config/site";
import { trackEvent } from "../lib/analytics";
import { EASE } from "../lib/motion";
import Carousel, { type CarouselImage } from "./Carousel";

const PHOTO_CATEGORIES = [
  {
    id: "kite",
    icon: MdAir,
    label: "Kite",
    titleMain: "O vento que não",
    titleAccent: "para de soprar",
    description:
      "Mar e lagoa a poucos minutos, com vento constante o ano inteiro. Um dos motivos pelos quais quem vive o kitesurf escolhe Taíba como base.",
    images: [
      { src: assetPath("images/kite/kite-mar.webp"), alt: "Kitesurfista descendo uma onda no mar de Taíba", fit: "cover" },
      { src: assetPath("images/kite/kite-mar2.webp"), alt: "Pipas de kitesurf na areia à beira-mar", fit: "cover" },
      { src: assetPath("images/kite/kite-mar3.webp"), alt: "Casal preparando o equipamento de kitesurf na praia", fit: "cover" },
      { src: assetPath("images/kite/kite-lagoa1.webp"), alt: "Kitesurfistas na lagoa ao pôr do sol", fit: "cover" },
      { src: assetPath("images/kite/kite-lagoa2.webp"), alt: "Kitesurfista na lagoa com o sol se pondo no horizonte", fit: "cover" },
      { src: assetPath("images/kite/lagoa1.webp"), alt: "Pipas de kite voando sobre a lagoa ao entardecer", fit: "cover" },
      { src: assetPath("images/kite/lagoa2.webp"), alt: "Kitesurfista na lagoa com os aerogeradores ao fundo", fit: "cover" },
    ] satisfies CarouselImage[],
  },
  {
    id: "paisaje",
    icon: MdLandscape,
    label: "Paisagem",
    titleMain: "Paisagens que",
    titleAccent: "ficam na memória",
    description:
      "Falésias, coqueirais e o mar mudando de cor ao longo do dia. Taíba é desses lugares que rendem a melhor foto da viagem sem nem precisar procurar.",
    images: [
      { src: assetPath("images/paisaje/praia.webp"), alt: "Vista aérea da praia de Taíba com casas entre os coqueirais", fit: "cover" },
      { src: assetPath("images/paisaje/paisaje.webp"), alt: "Pôr do sol entre as árvores na praia de Taíba", fit: "cover" },
      { src: assetPath("images/paisaje/paisaje1.webp"), alt: "Pôr do sol na praia de Taíba entre coqueiros", fit: "cover" },
      { src: assetPath("images/paisaje/paisaje3.webp"), alt: "Barco de pescador na praia ao pôr do sol", fit: "cover" },
      { src: assetPath("images/paisaje/paisaje4.webp"), alt: "Barcos de pesca coloridos na areia da praia", fit: "cover" },
      { src: assetPath("images/paisaje/paisaje8.webp"), alt: "Caminho à beira-mar entre as árvores até a praia", fit: "cover" },
      { src: assetPath("images/paisaje/paisaje9.webp"), alt: "Beco estreito entre casas caiadas de branco, a caminho da praia", fit: "cover" },
      { src: assetPath("images/paisaje/paisaje10.webp"), alt: "Detalhe de cordas em um barco de pescador na praia", fit: "cover" },
      { src: assetPath("images/paisaje/paisaje11.webp"), alt: "Praia de Taíba vista de um mirante, ao entardecer", fit: "cover" },
      { src: assetPath("images/paisaje/paisaje12.webp"), alt: "Palmeiras balançando ao vento contra o céu azul", fit: "cover" },
      { src: assetPath("images/paisaje/paisaje13.webp"), alt: "Falésia e coqueiros refletidos na areia molhada", fit: "cover" },
    ] satisfies CarouselImage[],
  },
] as const;

const HIGHLIGHTS = [
  {
    icon: MdAir,
    title: "Vento e Esportes de Prancha",
    description:
      "Taíba é conhecida pelo vento constante que atrai kitesurf, wingsurf e outros esportes de prancha, mantendo a vila conectada ao ritmo do mar.",
  },
  {
    icon: MdWbSunny,
    title: "Sol o Ano Inteiro",
    description:
      "Clima tropical com temperaturas médias de 28°C. O sol brilha em Taíba praticamente todos os dias.",
  },
  {
    icon: MdSurfing,
    title: "Praia Paradisíaca",
    description:
      "Coqueirais, falésias e águas mornas. A melhor combinação para dias inesquecíveis à beira-mar.",
  },
  {
    icon: MdLocationOn,
    title: "Acesso Fácil",
    description:
      "A apenas 70 km de Fortaleza, com estrada asfaltada até a pousada. Chegou, relaxou.",
  },
] as const;

const ease = EASE;

export default function TaibaGuide() {
  const reduce = useReducedMotion();
  const [activePhoto, setActivePhoto] = useState<string>("kite");
  const currentPhoto = PHOTO_CATEGORIES.find((c) => c.id === activePhoto) ?? PHOTO_CATEGORIES[0];

  return (
    <section id="taiba" className="relative py-24 md:py-36 bg-warm-900 overflow-hidden">
      {/* Background photo */}
      <div className="absolute inset-0">
        <img
          src={assetPath("images/dron.webp")}
          alt=""
          className="w-full h-full object-cover opacity-45"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-warm-900/75 via-warm-900/55 to-warm-900/80" />
      </div>

      <div className="relative z-10 max-w-[1440px] mx-auto px-6 md:px-10">
        {/* Section header */}
        <motion.div
          initial={reduce ? false : { y: 16 }}
          whileInView={reduce ? undefined : { y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.6, ease }}
        >
          <div className="flex items-center gap-5 mb-5">
            <span className="w-12 h-px bg-white/25" />
            <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-white/55">
              Conheça Taíba
            </span>
          </div>
          <h2 className="font-heading text-4xl md:text-5xl font-semibold text-white leading-[0.98] tracking-tight">
            O paraíso espera<br />
            por você
          </h2>
        </motion.div>

        {/* Highlights grid */}
        <div className="mt-14 grid grid-cols-1 md:grid-cols-2 gap-px bg-white/10">
          {HIGHLIGHTS.map((item, i) => (
            <motion.div
              key={item.title}
              className="flex gap-5 p-8 bg-warm-900/70 hover:bg-warm-800/60 transition-colors duration-300"
              initial={reduce ? false : { y: 16 }}
              whileInView={reduce ? undefined : { y: 0 }}
              viewport={{ once: true, amount: 0.15 }}
              transition={{ duration: 0.5, delay: 0.08 + i * 0.08, ease }}
            >
              <div className="shrink-0 w-10 h-10 flex items-center justify-center border border-white/20">
                <item.icon className="text-white/70" size={18} />
              </div>
              <div>
                <h3 className="font-heading text-base font-semibold text-white tracking-[0.01em]">
                  {item.title}
                </h3>
                <p className="mt-2 font-body text-sm leading-[1.7] text-white/60">
                  {item.description}
                </p>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Galeria de fotos: Kite / Paisagem */}
        <motion.div
          className="mt-16"
          initial={reduce ? false : { y: 16 }}
          whileInView={reduce ? undefined : { y: 0 }}
          viewport={{ once: true, amount: 0.15 }}
          transition={{ duration: 0.5, delay: 0.2, ease }}
        >
          <div className="flex flex-wrap gap-2">
            {PHOTO_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setActivePhoto(cat.id)}
                aria-pressed={activePhoto === cat.id}
                className={`inline-flex items-center gap-2 px-5 py-2.5 font-body text-[11px] font-semibold uppercase tracking-[0.12em] rounded-full transition-all duration-200 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                  activePhoto === cat.id
                    ? "bg-white text-warm-900"
                    : "border border-white/25 text-white/70 hover:border-white/50 hover:text-white"
                }`}
              >
                <cat.icon size={13} />
                {cat.label}
              </button>
            ))}
          </div>

          <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-24 items-start">
            <div className="relative min-w-0">
              <Carousel
                key={currentPhoto.id}
                images={currentPhoto.images}
                className="w-full h-full object-contain"
                wrapperClassName="h-[620px] max-w-[600px] mx-auto rounded-sm bg-white/5"
              />
              <div className="absolute -bottom-8 -right-8 w-40 h-40 bg-white/5 -z-10" />
            </div>

            <div>
              <AnimatePresence mode="wait">
                <motion.div
                  key={currentPhoto.id}
                  initial={reduce ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? undefined : { opacity: 0, y: -6 }}
                  transition={{ duration: 0.3 }}
                >
                  <div className="flex items-center gap-5 mb-8">
                    <span className="w-12 h-px bg-white/25" />
                    <span className="font-body text-[10px] font-semibold uppercase tracking-[0.3em] text-white/55">
                      {currentPhoto.label}
                    </span>
                  </div>
                  <h3 className="font-heading text-3xl md:text-4xl font-semibold text-white leading-[0.98] tracking-tight">
                    {currentPhoto.titleMain}<br />
                    <span className="text-coral-300">{currentPhoto.titleAccent}</span>
                  </h3>
                  <p className="mt-7 font-body text-base leading-[1.75] text-white/60 max-w-[52ch]">
                    {currentPhoto.description}
                  </p>
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </motion.div>

        {/* Location link */}
        <motion.div
          className="mt-10"
          initial={reduce ? false : { y: 16 }}
          whileInView={reduce ? undefined : { y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.4, ease }}
        >
          <a
            href={MAPS_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackEvent("click_google_maps")}
            className="inline-flex items-center gap-2 font-body text-sm text-white/50 hover:text-white/80 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white rounded"
          >
            <MdLocationOn size={15} />
            R. Francisca Ferreira Martins, 1121 — Taíba, CE
          </a>
        </motion.div>
      </div>
    </section>
  );
}
