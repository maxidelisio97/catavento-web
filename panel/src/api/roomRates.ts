import { apiFetch } from "./client";

export interface RoomRateRow {
  id: number;
  occupancy: number;
  weekday_cents: number;
  weekend_cents: number;
}

export interface RoomRatesGroup {
  room_id: number;
  room_name: string;
  rates: RoomRateRow[];
}

export interface RoomRatePatch {
  weekday_cents?: number;
  weekend_cents?: number;
}

export function getRoomRates(): Promise<RoomRatesGroup[]> {
  return apiFetch("/panel/room-rates");
}

export function updateRoomRate(id: number, patch: RoomRatePatch): Promise<RoomRateRow> {
  return apiFetch(`/panel/room-rates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}
