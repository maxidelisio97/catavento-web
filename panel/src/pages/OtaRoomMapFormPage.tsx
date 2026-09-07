import { useState } from "react";
import { setChannexRoomTypeMap, type ChannexLocalRoom, type ChannexRoomType } from "../api/channex";
import { ApiError } from "../api/client";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import { SelectField, TextField } from "../components/ui/Field";

interface OtaRoomMapFormPageProps {
  room: ChannexLocalRoom;
  channexRoomTypes: ChannexRoomType[];
  onSaved: () => void;
  onCancel: () => void;
}

// Channex has no "list rate plans" endpoint (channexClient.ts only exposes
// getProperty/listRoomTypes) — the rate plan ID is typed in by hand, unlike
// the room type, which comes from a real dropdown.
export default function OtaRoomMapFormPage({ room, channexRoomTypes, onSaved, onCancel }: OtaRoomMapFormPageProps) {
  const [roomTypeId, setRoomTypeId] = useState(room.channex_room_type_id ?? "");
  const [ratePlanId, setRatePlanId] = useState(room.channex_rate_plan_id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!roomTypeId) return;

    setError(null);
    setSaving(true);
    try {
      await setChannexRoomTypeMap({
        room_id: room.room_id,
        channex_room_type_id: roomTypeId,
        channex_rate_plan_id: ratePlanId.trim() === "" ? null : ratePlanId.trim(),
      });
      onSaved();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 409
            ? "Este Room Type do Channex já está associado a outro quarto."
            : err.message
          : "Erro inesperado ao salvar.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-md">
      <Card as="form" onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-panel-900">{room.room_name}</h2>
        </div>

        <SelectField
          id="ota-room-type"
          label="Room Type (Channex)"
          required
          value={roomTypeId}
          onChange={(e) => setRoomTypeId(e.target.value)}
        >
          <option value="">Selecione...</option>
          {channexRoomTypes.map((roomType) => (
            <option key={roomType.id} value={roomType.id}>
              {roomType.title}
            </option>
          ))}
        </SelectField>

        <TextField
          id="ota-rate-plan"
          label="Rate Plan ID (Channex)"
          value={ratePlanId}
          onChange={(e) => setRatePlanId(e.target.value)}
          help="UUID do rate plan no Channex. Deixe em branco para remover."
        />

        {error && (
          <p role="alert" className="text-sm text-danger-500">
            {error}
          </p>
        )}

        <div className="flex gap-2 mt-2">
          <Button type="submit" variant="primary" disabled={saving || !roomTypeId}>
            {saving ? "Salvando..." : "Salvar"}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </Card>
    </div>
  );
}
