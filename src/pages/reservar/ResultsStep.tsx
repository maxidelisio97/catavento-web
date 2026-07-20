/*
 * Paso 2 de /reservar: tipos de quarto disponiveis para o range escolhido,
 * com preco TOTAL do periodo. Tipos sem disponibilidade aparecem
 * desabilitados (nunca ocultos) — SPEC-modulo-3, passo 2.
 */
import { useEffect, useState } from "react";
import { LuArrowLeft, LuUsers } from "react-icons/lu";
import { fetchAvailability, type AvailabilityRoom } from "../../lib/api";
import { formatCents, formatIsoDateLabel } from "./formatters";

interface ResultsStepProps {
  checkIn: string;
  checkOut: string;
  guests: number;
  onSelectRoom: (room: AvailabilityRoom) => void;
  onBack: () => void;
}

export default function ResultsStep({ checkIn, checkOut, guests, onSelectRoom, onBack }: ResultsStepProps) {
  const requestKey = `${checkIn}|${checkOut}|${guests}`;
  const [result, setResult] = useState<{ key: string; rooms: AvailabilityRoom[] } | null>(null);
  const [fetchError, setFetchError] = useState<{ key: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchAvailability({ checkIn, checkOut, guests })
      .then((res) => {
        if (!cancelled) setResult({ key: requestKey, rooms: res.rooms });
      })
      .catch(() => {
        if (!cancelled) {
          setFetchError({ key: requestKey, message: "Não conseguimos consultar a disponibilidade agora. Tente novamente." });
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requestKey is derived from these same deps
  }, [checkIn, checkOut, guests]);

  const rooms = result?.key === requestKey ? result.rooms : null;
  const error = fetchError?.key === requestKey ? fetchError.message : null;

  return (
    <div className="w-full max-w-2xl mx-auto space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 font-body text-sm text-warm-800/60 hover:text-coral-600 transition-colors"
      >
        <LuArrowLeft size={16} aria-hidden />
        Alterar datas
      </button>

      <div>
        <h2 className="font-heading text-2xl text-warm-900">Quartos disponíveis</h2>
        <p className="mt-1 font-body text-sm text-warm-800/60">
          {formatIsoDateLabel(checkIn)} — {formatIsoDateLabel(checkOut)} · {guests} {guests === 1 ? "hóspede" : "hóspedes"}
        </p>
      </div>

      {error && (
        <p role="alert" className="font-body text-sm text-coral-600">
          {error}
        </p>
      )}

      {!rooms && !error && <p className="font-body text-sm text-warm-800/60">Consultando disponibilidade…</p>}

      {rooms && rooms.length === 0 && (
        <p className="font-body text-sm text-warm-800/60">
          Nenhum tipo de quarto comporta {guests} {guests === 1 ? "hóspede" : "hóspedes"}.
        </p>
      )}

      <div className="space-y-3">
        {rooms?.map((room) => (
          <button
            key={room.room_id}
            type="button"
            disabled={!room.available}
            onClick={() => onSelectRoom(room)}
            className="w-full text-left rounded-2xl border border-stone-300 bg-white p-5 flex items-center justify-between gap-4 transition-colors enabled:hover:border-coral-500 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-400"
          >
            <div>
              <p className="font-heading text-lg text-warm-900">{room.name}</p>
              <p className="mt-0.5 flex items-center gap-1.5 font-body text-xs text-warm-800/50">
                <LuUsers size={14} aria-hidden />
                até {room.capacity} hóspedes
              </p>
              {!room.available && (
                <p className="mt-2 font-body text-xs text-coral-600">Sem disponibilidade para essas datas</p>
              )}
              {room.available && room.units_left <= 2 && (
                <p className="mt-2 font-body text-xs text-coral-600">Últimas {room.units_left}!</p>
              )}
            </div>
            {room.available && room.total_cents != null && (
              <div className="text-right shrink-0">
                <p className="font-heading text-xl text-warm-900">{formatCents(room.total_cents)}</p>
                <p className="font-body text-[11px] text-warm-800/50">total da estadia</p>
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
