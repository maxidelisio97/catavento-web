import { apiFetch } from "./client";

export interface TapeChartUnit {
  id: number;
  label: string;
  room_type: string;
  capacity: number;
  sort_order: number;
}

export interface TapeChartNight {
  night: string;
  room_unit_id: number;
  reservation_id: number;
  code: string | null;
  guest_name: string | null;
  has_balance_due: boolean;
  is_first_night: boolean;
  is_last_night: boolean;
  is_fragmented: boolean;
  fragment_group: number | null;
}

export interface TapeChartSummary {
  arrivals_today: number;
  departures_today: number;
  occupied_today: number;
  total_units: number;
}

export interface TapeChartResult {
  from: string;
  to: string;
  units: TapeChartUnit[];
  nights: TapeChartNight[];
  summary: TapeChartSummary;
}

export function getTapeChart(from: string, to: string): Promise<TapeChartResult> {
  return apiFetch(`/panel/tape-chart?from=${from}&to=${to}`);
}

export interface ReservationDetail {
  id: number;
  code: string | null;
  status: string;
  arrival: string;
  departure: string;
  nights: number;
  room_type: { id: number; name: string };
  units: { night: string; unit_label: string }[];
  guests: { adults: number; children: number; children_ages: number[]; babies: number; total: number };
  money: { total_cents: number; deposit_cents: number | null; paid_cents: number; balance_cents: number };
  origin: string;
  contact: { name: string | null; email: string | null; phone: string | null };
  comments: string | null;
  created_at: string;
}

export function getReservationDetail(id: number): Promise<ReservationDetail> {
  return apiFetch(`/panel/reservations/${id}`);
}
