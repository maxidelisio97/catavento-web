import { useEffect, useState } from "react";
import {
  getChannexMappingStatus,
  getChannexRoomTypes,
  type ChannexLocalRoom,
  type ChannexMappingStatus,
  type ChannexRoomType,
} from "../api/channex";
import { ApiError } from "../api/client";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import OtaRoomMapFormPage from "./OtaRoomMapFormPage";

type View = { mode: "list" } | { mode: "edit"; room: ChannexLocalRoom };

export default function OtaRoomMappingPage() {
  const [localRooms, setLocalRooms] = useState<ChannexLocalRoom[] | null>(null);
  const [channexRoomTypes, setChannexRoomTypes] = useState<ChannexRoomType[] | null>(null);
  const [status, setStatus] = useState<ChannexMappingStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ mode: "list" });

  function reload() {
    setLoadError(null);
    Promise.all([getChannexRoomTypes(), getChannexMappingStatus()])
      .then(([roomTypesData, statusData]) => {
        setLocalRooms(roomTypesData.local_rooms);
        setChannexRoomTypes(roomTypesData.channex_room_types);
        setStatus(statusData);
      })
      .catch((err) => {
        // 400 here means property_id ainda não configurado (§ config
        // entrega 1) — a distinct, expected state, not a load failure.
        if (err instanceof ApiError && err.status === 400) {
          setLoadError("Configure o Property ID na aba Conexão antes de mapear os quartos.");
        } else {
          setLoadError("Não foi possível carregar o mapeamento.");
        }
      });
  }

  useEffect(reload, []);

  if (view.mode === "edit" && channexRoomTypes) {
    return (
      <OtaRoomMapFormPage
        room={view.room}
        channexRoomTypes={channexRoomTypes}
        onSaved={() => {
          setView({ mode: "list" });
          reload();
        }}
        onCancel={() => setView({ mode: "list" })}
      />
    );
  }

  if (loadError) {
    return <p className="text-sm text-panel-500">{loadError}</p>;
  }

  if (!localRooms || !channexRoomTypes || !status) {
    return <p className="text-sm text-panel-500">Carregando...</p>;
  }

  const roomTypeById = new Map(channexRoomTypes.map((roomType) => [roomType.id, roomType]));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Badge tone={status.complete ? "success" : "neutral"}>
          {status.mapped_rooms} de {status.total_rooms} mapeados
        </Badge>
      </div>

      <div className="bg-white border border-panel-200 rounded-panel-md overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-panel-50 border-b border-panel-200 text-left text-panel-500">
              <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Quarto</th>
              <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Room Type (Channex)</th>
              <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Status</th>
              <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide"></th>
            </tr>
          </thead>
          <tbody>
            {localRooms.map((room) => {
              const roomType = room.channex_room_type_id ? roomTypeById.get(room.channex_room_type_id) : undefined;
              const mapped = room.channex_room_type_id !== null && room.channex_rate_plan_id !== null;

              return (
                <tr key={room.room_id} className="border-b border-panel-150 last:border-b-0 hover:bg-panel-50">
                  <td className="px-4 py-2.5 text-panel-900 font-medium">{room.room_name}</td>
                  <td className="px-4 py-2.5 text-panel-600">{roomType?.title ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={mapped ? "success" : "neutral"}>{mapped ? "Mapeado" : "Não mapeado"}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button size="sm" variant="secondary" onClick={() => setView({ mode: "edit", room })}>
                      Editar
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
