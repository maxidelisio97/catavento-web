import { apiFetch } from "./client";

// SDD "Nova reserva" panel change, PR 3b — mirrors
// server/src/plugins/panelRoomFreeUnits.ts's response shape field-for-field.
export interface RoomFreeUnit {
  id: number;
  label: string;
  free: boolean;
}

export interface RoomFreeUnitsResult {
  room_id: number;
  check_in: string;
  check_out: string;
  units: RoomFreeUnit[];
}

export function getFreeUnits(roomId: number, checkIn: string, checkOut: string): Promise<RoomFreeUnitsResult> {
  const params = new URLSearchParams({ check_in: checkIn, check_out: checkOut });
  return apiFetch(`/panel/rooms/${roomId}/free-units?${params.toString()}`);
}

// mirrors server/src/plugins/panelRoomTypes.ts's response shape — id+name
// only, no pricing, so this is reachable with just reservations.create_manual
// (unlike /panel/room-rates, which also needs config.settings).
export interface RoomType {
  id: number;
  name: string;
}

export function getRoomTypes(): Promise<{ rooms: RoomType[] }> {
  return apiFetch("/panel/room-types");
}
