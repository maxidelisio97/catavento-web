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
import { ApiError, fetchReservationByCode, type AvailabilityRoom, type ReservationResponse } from "../../lib/api";
import { WHATSAPP_URL } from "../../config/site";

interface PartyFields {
  guests: number;
  children: number;
  babies: number;
  childrenAges: number[];
}

type Step =
  | { name: "loading" }
  | { name: "dates"; initial?: DatesStepInitial }
  | ({ name: "results"; checkIn: string; checkOut: string } & PartyFields)
  | ({ name: "guest"; checkIn: string; checkOut: string; room: AvailabilityRoom } & PartyFields)
  | { name: "confirmation"; reservation: ReservationResponse }
  // Distinct from a genuine 404: this is "we don't know if your reservation
  // exists" (network blip, backend error), NOT "your reservation doesn't
  // exist" — conflating the two here previously sent guests who had just
  // paid back to a blank search after their confirmation page failed to
  // load (see server/CLAUDE.md "Deuda conocida").
  | { name: "code-lookup-failed"; code: string };

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
  const [step, setStep] = useState<Step>(() => {
    if (codeFromUrl) return { name: "loading" };
    // Datas ja vieram prontas do seletor da home (ver comentario do topo do
    // arquivo) — pular a tela de datas em vez de repetir um seletor que o
    // hospede acabou de usar.
    if (initialFromUrl?.checkIn && initialFromUrl?.checkOut) {
      return {
        name: "results",
        checkIn: initialFromUrl.checkIn,
        checkOut: initialFromUrl.checkOut,
        guests: initialFromUrl.guests ?? 2,
        children: 0,
        babies: 0,
        childrenAges: [],
      };
    }
    return { name: "dates", initial: initialFromUrl };
  });

  // retryCount only exists to give the "Tentar novamente" button a way to
  // re-run this effect without duplicating the fetch call inline.
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!codeFromUrl) return;
    let cancelled = false;
    setStep({ name: "loading" });
    fetchReservationByCode(codeFromUrl)
      .then((reservation) => {
        if (!cancelled) setStep({ name: "confirmation", reservation });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setStep({
            name: "dates",
            initial: { errorMessage: "Não encontramos essa reserva. Faça uma nova busca." },
          });
        } else {
          // Anything else (5xx, network) means we genuinely don't know the
          // reservation's status — never claim "not found" for that.
          setStep({ name: "code-lookup-failed", code: codeFromUrl });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [codeFromUrl, retryCount]);

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
            onSubmit={({ checkIn, checkOut, guests, children, babies, childrenAges }) =>
              setStep({ name: "results", checkIn, checkOut, guests, children, babies, childrenAges })
            }
          />
        )}

        {step.name === "results" && (
          <ResultsStep
            checkIn={step.checkIn}
            checkOut={step.checkOut}
            guests={step.guests}
            children={step.children}
            babies={step.babies}
            onBack={() => setStep({ name: "dates", initial: step })}
            onSelectRoom={(room) =>
              setStep({
                name: "guest",
                checkIn: step.checkIn,
                checkOut: step.checkOut,
                guests: step.guests,
                children: step.children,
                babies: step.babies,
                childrenAges: step.childrenAges,
                room,
              })
            }
          />
        )}

        {step.name === "guest" && (
          <GuestDataStep
            room={step.room}
            checkIn={step.checkIn}
            checkOut={step.checkOut}
            guests={step.guests}
            children={step.children}
            babies={step.babies}
            childrenAges={step.childrenAges}
            onBack={() =>
              setStep({
                name: "results",
                checkIn: step.checkIn,
                checkOut: step.checkOut,
                guests: step.guests,
                children: step.children,
                babies: step.babies,
                childrenAges: step.childrenAges,
              })
            }
            onSuccess={(reservation) => setStep({ name: "confirmation", reservation })}
            onNoAvailability={() =>
              setStep({
                name: "dates",
                initial: {
                  checkIn: step.checkIn,
                  checkOut: step.checkOut,
                  guests: step.guests,
                  children: step.children,
                  babies: step.babies,
                  childrenAges: step.childrenAges,
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

        {step.name === "code-lookup-failed" && (
          <div className="w-full max-w-md mx-auto text-center space-y-4 pt-16">
            <p className="font-body text-sm text-warm-800/70">
              Não conseguimos carregar sua reserva agora. Se você acabou de pagar, o pagamento pode ter sido
              registrado mesmo assim — antes de tentar pagar de novo, atualize esta página em alguns instantes ou
              fale com a pousada pelo WhatsApp informando o código{" "}
              <span className="font-semibold text-warm-900">{step.code}</span>.
            </p>
            <button
              type="button"
              onClick={() => setRetryCount((c) => c + 1)}
              className="w-full h-12 rounded-xl bg-coral-600 hover:bg-coral-500 text-white font-body font-semibold transition-colors active:scale-[0.98]"
            >
              Tentar novamente
            </button>
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noreferrer"
              className="block font-body text-sm text-coral-600 hover:underline"
            >
              Falar com a pousada pelo WhatsApp
            </a>
          </div>
        )}
      </main>
    </div>
  );
}
