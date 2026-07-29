import { useEffect, useState } from "react";
import { getRoomRates, type RoomRatesGroup } from "../../api/roomRates";
import {
  applyRateOverridesRange,
  getRateOverrides,
  putRateOverride,
  UnitsAvailableConflictError,
  type RangeApplyResult,
  type RateOverridePatch,
  type RateOverrideRow,
} from "../../api/rateOverrides";
import { ApiError } from "../../api/client";
import {
  addMonthsUTC,
  buildMonthGrid,
  dayOfMonth,
  formatDateDisplay,
  formatMoneyCents,
  isInMonth,
  isWeekendNight,
  monthLabel,
  todayISO,
} from "../../lib/dateUtils";
import { ClosedIcon, ReducedUnitsIcon } from "./icons";

// SPEC-modulo-8-configuracion.md § 6.6: "grilla mensual, por cuarto (o
// todos)". The calendar isn't guest-count-scoped, so — same fallback
// calculatePrice.ts uses when there's no exact occupancy match — the
// reference price shown per day is the room's highest-occupancy rate.
function baseRateCentsForRoom(group: RoomRatesGroup | undefined, night: string): number | null {
  if (!group || group.rates.length === 0) return null;
  const maxOccupancyRate = group.rates.reduce((max, r) => (r.occupancy > max.occupancy ? r : max), group.rates[0]!);
  return isWeekendNight(night) ? maxOccupancyRate.weekend_cents : maxOccupancyRate.weekday_cents;
}

interface DayCellProps {
  date: string;
  month: string;
  today: string;
  override: RateOverrideRow | undefined;
  baseCents: number | null;
  onSelect: (date: string) => void;
}

function DayCell({ date, month, today, override, baseCents, onSelect }: DayCellProps) {
  const inMonth = isInMonth(date, month);
  const hasOverride = override != null;
  const closed = override?.closed ?? false;
  const reducedUnits = !closed && override?.units_available != null;
  const effectiveCents = override?.price_cents ?? baseCents;

  return (
    <button
      type="button"
      disabled={!inMonth}
      onClick={() => onSelect(date)}
      className={[
        "flex flex-col gap-0.5 h-20 p-1.5 text-left border border-panel-100 rounded transition-colors",
        inMonth ? "bg-white hover:bg-panel-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-1" : "bg-panel-50/60 cursor-default",
      ].join(" ")}
    >
      <div className="flex items-start justify-between">
        <span className={date === today ? "text-xs font-semibold text-accent-600" : inMonth ? "text-xs text-panel-500" : "text-xs text-panel-300"}>
          {dayOfMonth(date)}
        </span>
        {hasOverride && inMonth && <span className="w-1.5 h-1.5 rounded-full bg-accent-500 mt-0.5" aria-hidden="true" />}
      </div>

      {inMonth && effectiveCents != null && (
        <span className={override?.price_cents != null ? "text-xs font-semibold text-panel-900" : "text-xs text-panel-500"}>
          {formatMoneyCents(effectiveCents)}
        </span>
      )}

      {inMonth && override?.min_stay != null && <span className="text-[10px] text-panel-500">mín {override.min_stay}</span>}

      {inMonth && (closed || reducedUnits) && (
        <span className="flex items-center gap-1 text-[10px] text-panel-700 mt-auto">
          {closed ? <ClosedIcon /> : <ReducedUnitsIcon />}
          {closed ? "Fechado" : `Cupo ${override!.units_available}`}
        </span>
      )}
    </button>
  );
}

interface DayEditDrawerProps {
  roomId: number;
  date: string;
  override: RateOverrideRow | undefined;
  onClose: () => void;
  onSaved: () => void;
}

function DayEditDrawer({ roomId, date, override, onClose, onSaved }: DayEditDrawerProps) {
  const [entered, setEntered] = useState(false);
  const [priceReais, setPriceReais] = useState(override?.price_cents != null ? (override.price_cents / 100).toFixed(2) : "");
  const [minStay, setMinStay] = useState(override?.min_stay != null ? String(override.min_stay) : "");
  const [closed, setClosed] = useState(override?.closed ?? false);
  const [unitsAvailable, setUnitsAvailable] = useState(override?.units_available != null ? String(override.units_available) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const patch: RateOverridePatch = {
        price_cents: priceReais === "" ? null : Math.round(Number(priceReais) * 100),
        min_stay: minStay === "" ? null : Number(minStay),
        closed,
        units_available: unitsAvailable === "" ? null : Number(unitsAvailable),
      };
      await putRateOverride(roomId, date, patch);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof UnitsAvailableConflictError) {
        setError(`Não é possível reduzir o cupo para ${err.requested}: já existem ${err.occupied} reserva(s) confirmada(s) nessa noite.`);
      } else {
        setError(err instanceof ApiError ? err.message : "Erro inesperado ao salvar.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Editar noite"
        onClick={(e) => e.stopPropagation()}
        className={[
          "h-full w-full md:max-w-sm bg-white shadow-xl overflow-y-auto p-6 flex flex-col gap-5",
          "motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out",
          entered ? "translate-x-0" : "motion-safe:translate-x-full",
        ].join(" ")}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-panel-900">{formatDateDisplay(date)}</h2>
          <button type="button" onClick={onClose} aria-label="Fechar" className="text-panel-500 hover:text-panel-900 text-xl leading-none px-1">
            ×
          </button>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="override_price" className="text-sm font-medium text-panel-700">
            Preço da noite (R$)
          </label>
          <div className="flex items-center gap-2">
            <input
              id="override_price"
              type="number"
              min={0}
              step="0.01"
              placeholder="Preço base"
              value={priceReais}
              onChange={(e) => setPriceReais(e.target.value)}
              className="flex-1 border border-panel-300 rounded px-3 py-2 text-sm text-panel-900 focus:outline-none focus:ring-2 focus:ring-accent-500"
            />
            {priceReais !== "" && (
              <button type="button" onClick={() => setPriceReais("")} className="text-xs text-panel-500 hover:text-panel-900 whitespace-nowrap">
                usar base
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="override_min_stay" className="text-sm font-medium text-panel-700">
            Mínimo de noites
          </label>
          <div className="flex items-center gap-2">
            <input
              id="override_min_stay"
              type="number"
              min={1}
              placeholder="Padrão do quarto"
              value={minStay}
              onChange={(e) => setMinStay(e.target.value)}
              className="flex-1 border border-panel-300 rounded px-3 py-2 text-sm text-panel-900 focus:outline-none focus:ring-2 focus:ring-accent-500"
            />
            {minStay !== "" && (
              <button type="button" onClick={() => setMinStay("")} className="text-xs text-panel-500 hover:text-panel-900 whitespace-nowrap">
                usar padrão
              </button>
            )}
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-panel-700">
          <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} className="accent-accent-500" />
          Fechar esta noite (bloqueia novas reservas)
        </label>

        <div className="flex flex-col gap-1">
          <label htmlFor="override_units" className="text-sm font-medium text-panel-700">
            Cupo disponível
          </label>
          <div className="flex items-center gap-2">
            <input
              id="override_units"
              type="number"
              min={0}
              placeholder="Total do quarto"
              value={unitsAvailable}
              onChange={(e) => setUnitsAvailable(e.target.value)}
              className="flex-1 border border-panel-300 rounded px-3 py-2 text-sm text-panel-900 focus:outline-none focus:ring-2 focus:ring-accent-500"
            />
            {unitsAvailable !== "" && (
              <button type="button" onClick={() => setUnitsAvailable("")} className="text-xs text-panel-500 hover:text-panel-900 whitespace-nowrap">
                usar total
              </button>
            )}
          </div>
          <p className="text-xs text-panel-500">Reduz quantas unidades podem ser reservadas nessa noite — independente de estar fechada.</p>
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="mt-auto bg-panel-900 text-white text-sm font-medium rounded py-2 hover:bg-panel-700 disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
        >
          {saving ? "Salvando..." : "Salvar"}
        </button>
      </div>
    </div>
  );
}

interface RangeFieldState {
  included: boolean;
  value: string;
}

const EMPTY_FIELD: RangeFieldState = { included: false, value: "" };

function RangeApplyForm({ roomId, onApplied }: { roomId: number; onApplied: () => void }) {
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [priceField, setPriceField] = useState<RangeFieldState>(EMPTY_FIELD);
  const [minStayField, setMinStayField] = useState<RangeFieldState>(EMPTY_FIELD);
  const [closedIncluded, setClosedIncluded] = useState(false);
  const [closedValue, setClosedValue] = useState(false);
  const [unitsField, setUnitsField] = useState<RangeFieldState>(EMPTY_FIELD);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RangeApplyResult | null>(null);

  const hasAnyField = priceField.included || minStayField.included || closedIncluded || unitsField.included;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!hasAnyField) return;

    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const patch: RateOverridePatch = {};
      if (priceField.included) patch.price_cents = priceField.value === "" ? null : Math.round(Number(priceField.value) * 100);
      if (minStayField.included) patch.min_stay = minStayField.value === "" ? null : Number(minStayField.value);
      if (closedIncluded) patch.closed = closedValue;
      if (unitsField.included) patch.units_available = unitsField.value === "" ? null : Number(unitsField.value);

      const applied = await applyRateOverridesRange(roomId, from, to, patch);
      setResult(applied);
      onApplied();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro inesperado ao aplicar.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-white border border-panel-200 rounded-lg p-6">
      <h3 className="text-sm font-semibold text-panel-900 mb-1">Aplicar em um período</h3>
      <p className="text-xs text-panel-500 mb-4">Ex.: subir o preço de todo janeiro, fechar do 20 ao 25, ou definir mínimo de 3 noites.</p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-md">
        <div className="flex items-center gap-3">
          <label className="flex flex-col gap-1 text-sm text-panel-700 flex-1">
            De
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required className="border border-panel-300 rounded px-3 py-2 text-sm text-panel-900 focus:outline-none focus:ring-2 focus:ring-accent-500" />
          </label>
          <label className="flex flex-col gap-1 text-sm text-panel-700 flex-1">
            Até
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} required className="border border-panel-300 rounded px-3 py-2 text-sm text-panel-900 focus:outline-none focus:ring-2 focus:ring-accent-500" />
          </label>
        </div>

        <div className="flex flex-col gap-2 border-t border-panel-100 pt-3">
          <label className="flex items-center gap-2 text-sm text-panel-700">
            <input type="checkbox" checked={priceField.included} onChange={(e) => setPriceField({ ...priceField, included: e.target.checked })} className="accent-accent-500" />
            Alterar preço
          </label>
          {priceField.included && (
            <input
              type="number"
              min={0}
              step="0.01"
              placeholder="Preço (R$) — vazio volta ao preço base"
              value={priceField.value}
              onChange={(e) => setPriceField({ ...priceField, value: e.target.value })}
              className="ml-6 border border-panel-300 rounded px-3 py-2 text-sm text-panel-900 focus:outline-none focus:ring-2 focus:ring-accent-500"
            />
          )}
        </div>

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm text-panel-700">
            <input type="checkbox" checked={minStayField.included} onChange={(e) => setMinStayField({ ...minStayField, included: e.target.checked })} className="accent-accent-500" />
            Alterar mínimo de noites
          </label>
          {minStayField.included && (
            <input
              type="number"
              min={1}
              placeholder="Mínimo de noites — vazio volta ao padrão"
              value={minStayField.value}
              onChange={(e) => setMinStayField({ ...minStayField, value: e.target.value })}
              className="ml-6 border border-panel-300 rounded px-3 py-2 text-sm text-panel-900 focus:outline-none focus:ring-2 focus:ring-accent-500"
            />
          )}
        </div>

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm text-panel-700">
            <input type="checkbox" checked={closedIncluded} onChange={(e) => setClosedIncluded(e.target.checked)} className="accent-accent-500" />
            Alterar fechamento
          </label>
          {closedIncluded && (
            <label className="ml-6 flex items-center gap-2 text-sm text-panel-700">
              <input type="checkbox" checked={closedValue} onChange={(e) => setClosedValue(e.target.checked)} className="accent-accent-500" />
              Fechar as noites do período (bloqueia novas reservas)
            </label>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm text-panel-700">
            <input type="checkbox" checked={unitsField.included} onChange={(e) => setUnitsField({ ...unitsField, included: e.target.checked })} className="accent-accent-500" />
            Alterar cupo disponível
          </label>
          {unitsField.included && (
            <input
              type="number"
              min={0}
              placeholder="Cupo — vazio volta ao total do quarto"
              value={unitsField.value}
              onChange={(e) => setUnitsField({ ...unitsField, value: e.target.value })}
              className="ml-6 border border-panel-300 rounded px-3 py-2 text-sm text-panel-900 focus:outline-none focus:ring-2 focus:ring-accent-500"
            />
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !hasAnyField}
          className="bg-panel-900 text-white text-sm font-medium rounded py-2 hover:bg-panel-700 disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
        >
          {submitting ? "Aplicando..." : "Aplicar ao período"}
        </button>
      </form>

      {result && (
        <div className="mt-4 border-t border-panel-200 pt-4 text-sm max-w-md">
          {result.price_min_stay_closed_applied && (
            <p className="text-panel-900">Preço/mínimo/fechamento aplicados às {result.nights} noites do período.</p>
          )}
          {result.units_available && (
            <p className="text-panel-900 mt-1">
              Cupo aplicado a {result.units_available.applied_count} de {result.nights} noites.
            </p>
          )}
          {result.units_available && result.units_available.failures.length > 0 && (
            <div className="mt-2">
              <p className="text-red-700 font-medium">Não foi possível ajustar o cupo em {result.units_available.failures.length} noite(s):</p>
              <ul className="mt-1 list-disc list-inside text-panel-700">
                {result.units_available.failures.map((failure) => (
                  <li key={failure.date}>
                    {formatDateDisplay(failure.date)} — {failure.occupied} reserva(s) já ocupam essa noite
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function RateOverridesCalendar() {
  const [rooms, setRooms] = useState<RoomRatesGroup[] | null>(null);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const [overrides, setOverrides] = useState<RateOverrideRow[] | null>(null);
  const [overridesError, setOverridesError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getRoomRates()
      .then((data) => {
        if (cancelled) return;
        setRooms(data);
        if (data.length > 0) setSelectedRoomId((current) => current ?? data[0]!.room_id);
      })
      .catch(() => {
        if (!cancelled) setRoomsError("Não foi possível carregar os quartos.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const grid = buildMonthGrid(month);
  const gridFrom = grid[0]!;
  const gridTo = grid[grid.length - 1]!;

  useEffect(() => {
    if (selectedRoomId == null) return;
    let cancelled = false;
    setOverridesError(null);
    getRateOverrides(selectedRoomId, gridFrom, gridTo)
      .then((rows) => {
        if (!cancelled) setOverrides(rows);
      })
      .catch(() => {
        if (!cancelled) setOverridesError("Não foi possível carregar o calendário.");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoomId, gridFrom, gridTo, refreshKey]);

  if (roomsError) return <p className="text-sm text-red-600">{roomsError}</p>;
  if (!rooms) return <p className="text-sm text-panel-500">Carregando...</p>;

  const selectedGroup = rooms.find((r) => r.room_id === selectedRoomId);
  const overridesByDate = new Map((overrides ?? []).map((row) => [row.date, row]));
  const today = todayISO();

  return (
    <div className="flex flex-col gap-6">
      <div className="bg-white border border-panel-200 rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <label htmlFor="calendar_room" className="text-sm font-medium text-panel-700">
              Quarto
            </label>
            <select
              id="calendar_room"
              value={selectedRoomId ?? ""}
              onChange={(e) => setSelectedRoomId(Number(e.target.value))}
              className="border border-panel-300 rounded px-3 py-2 text-sm text-panel-900 focus:outline-none focus:ring-2 focus:ring-accent-500"
            >
              {rooms.map((room) => (
                <option key={room.room_id} value={room.room_id}>
                  {room.room_name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <button type="button" onClick={() => setMonth((m) => addMonthsUTC(m, -1))} aria-label="Mês anterior" className="px-2 py-1 border border-panel-300 rounded hover:bg-panel-100 text-panel-700">
              ←
            </button>
            <span className="min-w-36 text-center font-medium text-panel-900">{monthLabel(month)}</span>
            <button type="button" onClick={() => setMonth((m) => addMonthsUTC(m, 1))} aria-label="Próximo mês" className="px-2 py-1 border border-panel-300 rounded hover:bg-panel-100 text-panel-700">
              →
            </button>
            <button type="button" onClick={() => setMonth(today.slice(0, 7))} className="px-3 py-1 border border-panel-300 rounded hover:bg-panel-100 text-panel-700 font-medium">
              Hoje
            </button>
            <input
              type="month"
              value={month}
              onChange={(e) => e.target.value && setMonth(e.target.value)}
              aria-label="Ir para mês"
              className="border border-panel-300 rounded px-2 py-1 text-panel-900"
            />
          </div>
        </div>

        {overridesError && (
          <p role="alert" className="text-sm text-red-600 mb-3">
            {overridesError}
          </p>
        )}

        <div className="grid grid-cols-7 gap-1 text-xs text-panel-500 mb-1">
          {["dom", "seg", "ter", "qua", "qui", "sex", "sáb"].map((label) => (
            <div key={label} className="text-center font-medium">
              {label}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {grid.map((date) => (
            <DayCell
              key={date}
              date={date}
              month={month}
              today={today}
              override={overridesByDate.get(date)}
              baseCents={selectedGroup ? baseRateCentsForRoom(selectedGroup, date) : null}
              onSelect={setSelectedDate}
            />
          ))}
        </div>

        <div className="flex items-center gap-4 mt-3 text-xs text-panel-500">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-500" /> com ajuste
          </span>
          <span className="flex items-center gap-1">
            <ClosedIcon /> fechado
          </span>
          <span className="flex items-center gap-1">
            <ReducedUnitsIcon /> cupo reduzido
          </span>
        </div>
      </div>

      {selectedRoomId != null && <RangeApplyForm roomId={selectedRoomId} onApplied={() => setRefreshKey((k) => k + 1)} />}

      {selectedRoomId != null && selectedDate && (
        <DayEditDrawer
          roomId={selectedRoomId}
          date={selectedDate}
          override={overridesByDate.get(selectedDate)}
          onClose={() => setSelectedDate(null)}
          onSaved={() => setRefreshKey((k) => k + 1)}
        />
      )}
    </div>
  );
}
