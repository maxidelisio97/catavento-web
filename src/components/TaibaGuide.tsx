/*
 * Explica los atractivos de Taiba y muestra datos destacados del destino.
 * Aca debo cambiar beneficios, textos turisticos, fondo o enlace al mapa.
 * Es una seccion informativa, no maneja reservas.
 */
import { MdWbSunny, MdAir, MdSurfing, MdLocationOn } from "react-icons/md";
import { assetPath, MAPS_URL } from "../config/site";
import { trackEvent } from "../lib/analytics";

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

export default function TaibaGuide() {
  return (
    <section id="taiba" className="relative py-24 md:py-36 bg-madera overflow-hidden">
      {/* Background photo */}
      <div className="absolute inset-0">
        <img
          src={assetPath("images/dron.webp")}
          alt=""
          className="w-full h-full object-cover opacity-45"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-madera/75 via-madera/55 to-madera/80" />
      </div>

      <div className="relative z-10 max-w-[1440px] mx-auto px-6 md:px-10">
        {/* Section header */}
        <div>
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
        </div>

        {/* Highlights grid */}
        <div className="mt-14 grid grid-cols-1 md:grid-cols-2 gap-px bg-white/10">
          {HIGHLIGHTS.map((item) => (
            <div
              key={item.title}
              className="flex gap-5 p-8 bg-madera/70 hover:bg-madera/50 transition-colors duration-300"
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
            </div>
          ))}
        </div>

        {/* Location link */}
        <div className="mt-10">
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
        </div>
      </div>
    </section>
  );
}
