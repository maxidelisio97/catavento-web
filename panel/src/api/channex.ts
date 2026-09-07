import { apiFetch } from "./client";

export interface ChannexConfig {
  connected: boolean;
  environment: "staging" | "production";
  property_id: string | null;
  is_active: boolean;
}

export interface ChannexConfigPatch {
  property_id?: string | null;
  is_active?: boolean;
}

export interface ChannexTestConnectionResult {
  ok: boolean;
  property?: { id: string; title?: string };
  error?: string;
}

export interface ChannexLocalRoom {
  room_id: number;
  room_name: string;
  channex_room_type_id: string | null;
  channex_rate_plan_id: string | null;
}

export interface ChannexRoomType {
  id: string;
  title: string;
  count_of_rooms: number;
}

export interface ChannexRoomTypesResponse {
  local_rooms: ChannexLocalRoom[];
  channex_room_types: ChannexRoomType[];
}

export interface ChannexRoomTypeMapInput {
  room_id: number;
  channex_room_type_id: string;
  channex_rate_plan_id: string | null;
}

export interface ChannexMappingStatus {
  complete: boolean;
  total_rooms: number;
  mapped_rooms: number;
}

export function getChannexConfig(): Promise<ChannexConfig> {
  return apiFetch("/panel/channex/config");
}

export function updateChannexConfig(patch: ChannexConfigPatch): Promise<ChannexConfig> {
  return apiFetch("/panel/channex/config", { method: "PATCH", body: JSON.stringify(patch) });
}

export function testChannexConnection(): Promise<ChannexTestConnectionResult> {
  return apiFetch("/panel/channex/test-connection", { method: "POST" });
}

export function getChannexRoomTypes(): Promise<ChannexRoomTypesResponse> {
  return apiFetch("/panel/channex/room-types");
}

export function setChannexRoomTypeMap(input: ChannexRoomTypeMapInput): Promise<void> {
  return apiFetch("/panel/channex/room-type-map", { method: "PUT", body: JSON.stringify(input) });
}

export function getChannexMappingStatus(): Promise<ChannexMappingStatus> {
  return apiFetch("/panel/channex/mapping-status");
}
