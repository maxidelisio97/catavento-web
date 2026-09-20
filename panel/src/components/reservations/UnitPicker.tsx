import type { RoomFreeUnit } from "../../api/rooms";

// SDD "Nova reserva" panel change, PR 3b — design § "Panel form structure".
// Radio group over {id, label, free}. Occupied units render DISABLED, not
// hidden (design D5): staff sees why a unit is gone after a 409, instead of
// a silently shrinking list. Default selection is "Qualquer unidade" (no
// preference, `value === null`) — equivalent to omitting
// `preferred_room_unit_id` from the submit payload entirely.

interface UnitPickerProps {
  units: RoomFreeUnit[] | null;
  loading: boolean;
  error: string | null;
  value: number | null;
  onChange: (unitId: number | null) => void;
}

export default function UnitPicker({ units, loading, error, value, onChange }: UnitPickerProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-panel-700">Unidade</span>

      {loading && <p className="text-xs text-panel-500">Carregando unidades...</p>}
      {error && (
        <p role="alert" className="text-xs text-danger-500">
          {error}
        </p>
      )}

      {/* The radio group stays visible alongside an error (design § "409
          PREFERRED_UNIT_TAKEN": reopen the picker WITH an inline message,
          not one or the other) — only hidden while a fetch is in flight. */}
      {!loading && (
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-[13px] text-panel-900">
            <input
              type="radio"
              name="reservation-unit"
              checked={value === null}
              onChange={() => onChange(null)}
            />
            Qualquer unidade
          </label>

          {(units ?? []).map((unit) => (
            <label
              key={unit.id}
              className={`flex items-center gap-2 text-[13px] ${
                unit.free ? "text-panel-900" : "text-panel-400"
              }`}
            >
              <input
                type="radio"
                name="reservation-unit"
                checked={value === unit.id}
                disabled={!unit.free}
                onChange={() => onChange(unit.id)}
              />
              {unit.label}
              {!unit.free && <span className="text-[11px]">(ocupada)</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
