/*
 * Presenta la pousada con texto institucional, estadisticas y diferenciais.
 * Aca debo cambiar la descripcion general, los datos destacados o los
 * diferenciais (amenities a nivel propiedad, no por cuarto).
 * No controla navegacion ni reservas.
 */
import { motion, useReducedMotion } from "motion/react";
import {
  MdWifi,
  MdPool,
  MdFreeBreakfast,
  MdLocalParking,
  MdAcUnit,
  MdShower,
  MdPets,
  MdAirportShuttle,
} from "react-icons/md";
import { EASE } from "../lib/motion";

const ease = EASE;

const STATS = [
  { value: "3+", label: "Anos de hospitalidade" },
  { value: "100m", label: "Da praia" },
  { value: "8,8", label: "Avaliação no Booking" },
  { value: "200m", label: "Do mirante" },
] as const;

const DIFERENCIAIS = [
  { icon: MdWifi, label: "Wi-Fi grátis" },
  { icon: MdPool, label: "Piscina" },
  { icon: MdFreeBreakfast, label: "Café da manhã incluso" },
  { icon: MdLocalParking, label: "Estacionamento" },
  { icon: MdAcUnit, label: "Ar-condicionado em todos os quartos" },
  { icon: MdShower, label: "Chuveiro quente em todos os quartos" },
  { icon: MdPets, label: "Aceita animais de estimação" },
  { icon: MdAirportShuttle, label: "Transfer desde o aeroporto" },
] as const;

export default function About() {
  const reduce = useReducedMotion();

  return (
    <section className="relative py-24 md:py-36 bg-white overflow-hidden">
      <div className="max-w-[1440px] mx-auto px-6 md:px-10 grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-24 items-stretch">
        {/* Texto */}
        <motion.div
          className="h-full"
          initial={reduce ? false : { x: -24 }}
          whileInView={reduce ? undefined : { x: 0 }}
          viewport={{ once: true, amount: 0.25 }}
          transition={{ duration: 0.8, ease }}
        >
          <div className="bg-sand-50 rounded-sm p-8 md:p-10 h-full">
            <h2 className="font-heading text-4xl md:text-5xl font-semibold text-warm-900 leading-[0.98] tracking-tight">
              Um refúgio feito<br />
              <span className="text-coral-500">para você</span>
            </h2>

            <div className="mt-7 space-y-4 font-body text-base leading-[1.75] text-warm-800/65 max-w-[52ch]">
              <p>
                A 100 metros da Praia da Taibinha e do melhor point de kitesurf,
                wingfoil, surf e demais esportes de vento, a Pousada Catavento é
                o destino ideal para quem busca tranquilidade e contato com a
                natureza. Quartos confortáveis, jardim e piscina ao ar livre —
                tudo pensado para sua melhor estadia.
              </p>
              <p>
                Aqui o vento sopra a seu favor. Perfeito para casais, famílias e
                aventureiros que querem viver uma experiência autêntica,
                explorando a força do vento, o calor do sol e a paz do mar.
              </p>
            </div>
          </div>
        </motion.div>

        {/* Stats + Diferenciais */}
        <motion.div
          className="h-full"
          initial={reduce ? false : { x: 24 }}
          whileInView={reduce ? undefined : { x: 0 }}
          viewport={{ once: true, amount: 0.25 }}
          transition={{ duration: 0.8, delay: 0.12, ease }}
        >
          <div className="bg-sand-50 rounded-sm p-8 md:p-10 h-full">
            {/* Stats */}
            <div className="grid grid-cols-2 gap-x-8 gap-y-8">
              {STATS.map((stat) => (
                <div key={stat.label}>
                  <p className="font-heading text-3xl font-semibold text-coral-600">{stat.value}</p>
                  <p className="font-body text-xs text-warm-800/55 mt-0.5 uppercase tracking-[0.1em]">{stat.label}</p>
                </div>
              ))}
            </div>

            {/* Diferenciais */}
            <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5 border-t border-sand-200 pt-8">
              {DIFERENCIAIS.map((item) => (
                <div key={item.label} className="flex items-center gap-3">
                  <span className="flex items-center justify-center w-9 h-9 rounded-full bg-white shrink-0">
                    <item.icon size={18} className="text-coral-600" />
                  </span>
                  <p className="font-body text-sm text-warm-800/75">{item.label}</p>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
