import { useEffect, useState } from "react";
import { getRoomRates, updateRoomRate, type RoomRatesGroup } from "../../api/roomRates";
import { ApiError } from "../../api/client";
import Button from "../ui/Button";

// Human-facing R$ strings per row, keyed by room_rates.id — converted to
// cents only at submit time, same pattern as SettingsPage's form
// (SPEC-modulo-8-configuracion.md § 5.3).
type RowForm = { weekday_reais: string; weekend_reais: string };
type RowStatus = { saving: boolean; saved: boolean; error: string | null };

function toRowForm(weekdayCents: number, weekendCents: number): RowForm {
  return {
    weekday_reais: (weekdayCents / 100).toFixed(2),
    weekend_reais: (weekendCents / 100).toFixed(2),
  };
}

export default function RoomRatesTable() {
  const [groups, setGroups] = useState<RoomRatesGroup[] | null>(null);
  const [forms, setForms] = useState<Record<number, RowForm>>({});
  const [statuses, setStatuses] = useState<Record<number, RowStatus>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRoomRates()
      .then((data) => {
        if (cancelled) return;
        setGroups(data);
        const nextForms: Record<number, RowForm> = {};
        for (const group of data) {
          for (const rate of group.rates) {
            nextForms[rate.id] = toRowForm(rate.weekday_cents, rate.weekend_cents);
          }
        }
        setForms(nextForms);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Não foi possível carregar os preços.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function setRowForm(id: number, patch: Partial<RowForm>) {
    setForms((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function handleSaveRow(id: number) {
    const form = forms[id];
    if (!form) return;

    const weekdayCents = Math.round(Number(form.weekday_reais) * 100);
    const weekendCents = Math.round(Number(form.weekend_reais) * 100);

    // Backend accepts 0 freely (a room rate is business data, not the
    // backend's call to judge) — but 0 on a room price is more likely a typo
    // than pet_fee_cents=0 (which is a normal "pets are free" config), so the
    // panel asks for confirmation here, matching the existing
    // window.confirm pattern in PanelLayout.handleLogoutAll (SPEC § 5.2).
    if (weekdayCents === 0 || weekendCents === 0) {
      const proceed = window.confirm(
        "Você está salvando um preço de R$ 0,00 para esta ocupação. Confirmar?",
      );
      if (!proceed) return;
    }

    setStatuses((prev) => ({ ...prev, [id]: { saving: true, saved: false, error: null } }));
    try {
      const updated = await updateRoomRate(id, { weekday_cents: weekdayCents, weekend_cents: weekendCents });
      setRowForm(id, toRowForm(updated.weekday_cents, updated.weekend_cents));
      setStatuses((prev) => ({ ...prev, [id]: { saving: false, saved: true, error: null } }));
    } catch (err) {
      setStatuses((prev) => ({
        ...prev,
        [id]: { saving: false, saved: false, error: err instanceof ApiError ? err.message : "Erro inesperado ao salvar." },
      }));
    }
  }

  if (loadError) {
    return <p className="text-sm text-danger-500">{loadError}</p>;
  }

  if (!groups) {
    return <p className="text-sm text-panel-500">Carregando...</p>;
  }

  return (
    <div className="bg-white border border-panel-200 rounded-panel-md overflow-hidden">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="bg-panel-50 border-b border-panel-200 text-left text-panel-500">
            <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Quarto</th>
            <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Ocupação</th>
            <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Diária semana (R$)</th>
            <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Diária fim de semana (R$)</th>
            <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide"></th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) =>
            group.rates.map((rate, index) => {
              const form = forms[rate.id];
              const status = statuses[rate.id];
              if (!form) return null;

              return (
                <tr key={rate.id} className="border-b border-panel-150 last:border-b-0 hover:bg-panel-50">
                  <td className="px-4 py-2.5 text-panel-900 font-medium">
                    {index === 0 ? group.room_name : ""}
                  </td>
                  <td className="px-4 py-2.5 text-panel-600">{rate.occupancy}</td>
                  <td className="px-4 py-2.5">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={form.weekday_reais}
                      onChange={(e) => setRowForm(rate.id, { weekday_reais: e.target.value })}
                      className="w-28 border border-panel-300 rounded-panel-sm px-2 py-1 text-[13px] text-panel-900 tabular-nums focus:outline-none focus:ring-3 focus:ring-accent-100 focus:border-accent-500"
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={form.weekend_reais}
                      onChange={(e) => setRowForm(rate.id, { weekend_reais: e.target.value })}
                      className="w-28 border border-panel-300 rounded-panel-sm px-2 py-1 text-[13px] text-panel-900 tabular-nums focus:outline-none focus:ring-3 focus:ring-accent-100 focus:border-accent-500"
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <Button size="sm" variant="primary" onClick={() => void handleSaveRow(rate.id)} disabled={status?.saving}>
                      {status?.saving ? "Salvando..." : "Salvar"}
                    </Button>
                    {status?.error && <p className="text-xs text-danger-500 mt-1">{status.error}</p>}
                    {status?.saved && !status.error && <p className="text-xs text-success-700 mt-1">Salvo.</p>}
                  </td>
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
    </div>
  );
}
