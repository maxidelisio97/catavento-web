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

export interface ChannexPullNowResult {
  total_feed_items: number;
  processed: number;
  acked: number;
}

/** § 3.4/§ 9: manual trigger for the Booking Revisions Feed pull — no cron until 12D. */
export function pullChannexNow(): Promise<ChannexPullNowResult> {
  return apiFetch("/panel/channex/pull-now", { method: "POST" });
}

export interface ChannexRetryConflictResult {
  resolved: boolean;
}

/** § 3.5: reassigns a unit for a reservation stuck in `ota_conflict`, if one is free now. */
export function retryOtaConflict(reservationId: number): Promise<ChannexRetryConflictResult> {
  return apiFetch(`/panel/channex/conflicts/${reservationId}/retry`, { method: "POST" });
}

export interface OtaConflictSummary {
  id: number;
  code: string | null;
  room_name: string;
  check_in: string;
  check_out: string;
  guests: number;
  guest_name: string | null;
  total_cents: number;
}

/** § 6: the tape chart can't show these (no reservation_nights rows) — this list is how an operator sees them. */
export function getOtaConflicts(): Promise<OtaConflictSummary[]> {
  return apiFetch("/panel/channex/conflicts");
}

export interface ChannexResyncResult {
  rooms_pushed: number;
  rooms_skipped: number;
}

/** § 3.3/§ 6: full ARI resync (6-month horizon) for every mapped room type — corrects drift the incremental push may have missed. */
export function resyncChannexAvailability(): Promise<ChannexResyncResult> {
  return apiFetch("/panel/channex/resync", { method: "POST" });
}
