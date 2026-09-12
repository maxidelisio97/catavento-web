import { useEffect, useState } from "react";
import {
  getChannexPullStatus,
  getOtaConflicts,
  pullChannexNow,
  retryOtaConflict,
  type ChannexPullStatus,
  type OtaConflictSummary,
  type ChannexPullNowResult,
} from "../api/channex";
import { ApiError } from "../api/client";
import { formatDateDisplay, formatMoneyCents } from "../lib/dateUtils";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";

/**
 * SPEC-modulo-12B-reservas-entrantes.md § 6. The tape chart is keyed
 * entirely off `reservation_nights` (unit × night) — an `ota_conflict`
 * reservation has none by design (§ 0.1), so it has nowhere to render
 * there. This page is the only place an operator sees and resolves them,
 * plus the manual pull trigger and the automated-pull status indicator
 * (SPEC-modulo-12D § 1/§ 2).
 */
function formatPullTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function OtaReservationsPage() {
  const [conflicts, setConflicts] = useState<OtaConflictSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState<ChannexPullNowResult | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);

  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  const [pullStatus, setPullStatus] = useState<ChannexPullStatus | null>(null);

  function reload() {
    getOtaConflicts()
      .then(setConflicts)
      .catch(() => setLoadError("Não foi possível carregar os conflitos de OTA."));
    getChannexPullStatus()
      .then(setPullStatus)
      .catch(() => {
        // Non-critical: the indicator just stays hidden if the status can't load.
      });
  }

  useEffect(() => {
    reload();
  }, []);

  async function handlePullNow() {
    setPulling(true);
    setPullError(null);
    setPullResult(null);
    try {
      const result = await pullChannexNow();
      setPullResult(result);
      reload();
    } catch (err) {
      setPullError(err instanceof ApiError ? err.message : "Erro inesperado ao buscar reservas.");
    } finally {
      setPulling(false);
    }
  }

  async function handleRetry(reservationId: number) {
    setRetryingId(reservationId);
    setRetryError(null);
    try {
      const result = await retryOtaConflict(reservationId);
      if (!result.resolved) {
        setRetryError("Ainda não há unidade livre para esta reserva.");
      }
      reload();
    } catch (err) {
      setRetryError(err instanceof ApiError ? err.message : "Não foi possível tentar resolver o conflito.");
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <Card className="p-6 flex flex-col gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-panel-900">Buscar reservas agora</h2>
          <p className="text-[12.5px] text-panel-500 mt-0.5">
            Verifica manualmente novas reservas/alterações/cancelamentos no Channex. Há também uma busca automática
            a cada 15-20 min — use este botão para verificar imediatamente.
          </p>
        </div>

        {pullStatus && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12.5px] font-medium text-panel-700">Busca automática</span>
            <Badge tone={pullStatus.stale ? "danger" : "success"}>
              {pullStatus.last_success_at ? `última: ${formatPullTimestamp(pullStatus.last_success_at)}` : "ainda não rodou"}
            </Badge>
          </div>
        )}

        {pullStatus?.stale && pullStatus.last_error && (
          <p className="text-[12.5px] text-danger-500">Última tentativa falhou: {pullStatus.last_error}</p>
        )}

        <Button variant="secondary" disabled={pulling} onClick={() => void handlePullNow()} className="self-start">
          {pulling ? "Buscando..." : "Buscar reservas agora"}
        </Button>

        {pullError && (
          <p role="alert" className="text-sm text-danger-500">
            {pullError}
          </p>
        )}
        {pullResult && !pullError && (
          <p className="text-sm text-success-700">
            {pullResult.total_feed_items} revisão(ões) encontrada(s), {pullResult.acked} confirmada(s) ao Channex.
          </p>
        )}
      </Card>

      <Card className="p-6 flex flex-col gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-panel-900">Conflitos de OTA</h2>
          <p className="text-[12.5px] text-panel-500 mt-0.5">
            Reservas de OTA sem unidade livre no momento em que chegaram — não aparecem no mapa porque não têm
            unidade atribuída ainda.
          </p>
        </div>

        {loadError && (
          <p role="alert" className="text-sm text-danger-500">
            {loadError}
          </p>
        )}
        {retryError && (
          <p role="alert" className="text-sm text-danger-500">
            {retryError}
          </p>
        )}

        {conflicts && conflicts.length === 0 && <p className="text-[13px] text-panel-500">Nenhum conflito no momento.</p>}

        {conflicts && conflicts.length > 0 && (
          <ul className="flex flex-col gap-2">
            {conflicts.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 rounded-lg border border-panel-200 p-3">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] font-medium text-panel-900">{c.room_name}</span>
                    <Badge tone="danger">Conflito de OTA</Badge>
                  </div>
                  <p className="text-[12.5px] text-panel-500">
                    {formatDateDisplay(c.check_in)} — {formatDateDisplay(c.check_out)} · {c.guests} hóspede(s)
                    {c.guest_name ? ` · ${c.guest_name}` : ""} · {formatMoneyCents(c.total_cents)}
                  </p>
                </div>
                <Button size="sm" onClick={() => void handleRetry(c.id)} disabled={retryingId === c.id}>
                  {retryingId === c.id ? "Tentando..." : "Tentar resolver"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
