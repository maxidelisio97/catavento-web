/*
 * Pagina /reservar: fluxo de reserva propio (SPEC-modulo-3) + pagamento do
 * deposito via Asaas (SPEC-modulo-4). NAO enlazada do site — acesso somente
 * por URL direta (regra de switch, CLAUDE.md raiz). Aceita ?arrival&
 * departure&adults na URL para deixar pronto o enganche futuro do form do
 * hero, sem ativa-lo. Tambem aceita ?code=XXXX: o redirect do Asaas apos um
 * pagamento com cartao volta para essa URL, e a pagina precisa reabrir
 * direto na tela de pagamento/confirmacao dessa reserva.
 */
import { useEffect, useMemo, useState } from "react";
import CataventoIcon from "../../components/CataventoIcon";
import DatesStep, { type DatesStepInitial } from "./DatesStep";
import ResultsStep from "./ResultsStep";
import GuestDataStep from "./GuestDataStep";
import ConfirmationStep from "./ConfirmationStep";
import { fetchReservationByCode, type AvailabilityRoom, type ReservationResponse } from "../../lib/api";

type Step =
  | { name: "loading" }
  | { name: "dates"; initial?: DatesStepInitial }
  | { name: "results"; checkIn: string; checkOut: string; guests: number }
  | { name: "guest"; checkIn: string; checkOut: string; guests: number; room: AvailabilityRoom }
  | { name: "confirmation"; reservation: ReservationResponse };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readInitialFromUrl(): DatesStepInitial | undefined {
  const params = new URLSearchParams(window.location.search);
  const arrival = params.get("arrival");
  const departure = params.get("departure");
  const adultsRaw = params.get("adults");

  if (!arrival || !departure || !ISO_DATE_RE.test(arrival) || !ISO_DATE_RE.test(departure)) return undefined;

  const adults = adultsRaw ? Number(adultsRaw) : undefined;
  return {
    checkIn: arrival,
    checkOut: departure,
    guests: adults && Number.isInteger(adults) && adults > 0 ? adults : undefined,
  };
}

function readCodeFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("code");
}

export default function ReservarPage() {
  const initialFromUrl = useMemo(() => readInitialFromUrl(), []);
  const codeFromUrl = useMemo(() => readCodeFromUrl(), []);
  const [step, setStep] = useState<Step>(() =>
    codeFromUrl ? { name: "loading" } : { name: "dates", initial: initialFromUrl },
  );

  useEffect(() => {
    if (!codeFromUrl) return;
    let cancelled = false;
    fetchReservationByCode(codeFromUrl)
      .then((reservation) => {
        if (!cancelled) setStep({ name: "confirmation", reservation });
      })
      .catch(() => {
        if (!cancelled) {
          setStep({
            name: "dates",
            initial: { errorMessage: "Não encontramos essa reserva. Faça uma nova busca." },
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [codeFromUrl]);

  return (
    <div className="min-h-screen bg-sand-50 flex flex-col">
      <header className="px-6 py-6">
        <div className="flex items-center gap-2.5">
          <CataventoIcon height={40} className="shrink-0 text-warm-900" />
          <span className="flex flex-col leading-none">
            <span className="font-heading font-bold text-xs tracking-[0.2em] uppercase text-warm-900">
              Catavento
            </span>
            <span className="font-body font-light text-[8px] tracking-[0.3em] uppercase text-warm-800/50">
              Pousada
            </span>
          </span>
        </div>
      </header>

      <main className="flex-1 px-6 pb-16">
        {step.name === "loading" && (
          <p className="w-full max-w-md mx-auto text-center font-body text-sm text-warm-800/60 pt-16">
            Carregando sua reserva…
          </p>
        )}

        {step.name === "dates" && (
          <DatesStep
            initial={step.initial}
            onSubmit={({ checkIn, checkOut, guests }) => setStep({ name: "results", checkIn, checkOut, guests })}
          />
        )}

        {step.name === "results" && (
          <ResultsStep
            checkIn={step.checkIn}
            checkOut={step.checkOut}
            guests={step.guests}
            onBack={() => setStep({ name: "dates", initial: step })}
            onSelectRoom={(room) =>
              setStep({ name: "guest", checkIn: step.checkIn, checkOut: step.checkOut, guests: step.guests, room })
            }
          />
        )}

        {step.name === "guest" && (
          <GuestDataStep
            room={step.room}
            checkIn={step.checkIn}
            checkOut={step.checkOut}
            guests={step.guests}
            onBack={() => setStep({ name: "results", checkIn: step.checkIn, checkOut: step.checkOut, guests: step.guests })}
            onSuccess={(reservation) => setStep({ name: "confirmation", reservation })}
            onNoAvailability={() =>
              setStep({
                name: "dates",
                initial: {
                  checkIn: step.checkIn,
                  checkOut: step.checkOut,
                  guests: step.guests,
                  errorMessage: "Essas datas acabaram de ficar ocupadas. Escolha outro período.",
                },
              })
            }
          />
        )}

        {step.name === "confirmation" && (
          <ConfirmationStep
            reservation={step.reservation}
            onRestart={(initial) => setStep({ name: "dates", initial })}
          />
        )}
      </main>
    </div>
  );
}
