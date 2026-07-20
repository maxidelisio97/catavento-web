/*
 * Cliente fetch para el booking engine propio (server/). Mismo origen en
 * produccion (Nginx proxea /api), proxy de Vite en dev (vite.config.ts).
 * Solo usado por /reservar — el resto del sitio sigue mandando a HQBeds.
 */

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? "Erro inesperado. Tente novamente.");
  }
  return body as T;
}

export interface AvailabilityRoom {
  room_id: number;
  name: string;
  capacity: number;
  available: boolean;
  units_left: number;
  total_cents: number | null;
  min_stay_ok: boolean;
}

export interface AvailabilityResponse {
  check_in: string;
  check_out: string;
  guests: number;
  rooms: AvailabilityRoom[];
}

export function fetchAvailability(params: { checkIn: string; checkOut: string; guests: number }) {
  const search = new URLSearchParams({
    check_in: params.checkIn,
    check_out: params.checkOut,
    guests: String(params.guests),
  });
  return apiFetch<AvailabilityResponse>(`/api/availability?${search.toString()}`);
}

export type ReservationStatus = "pending_payment" | "confirmed" | "cancelled" | "expired";

export interface ReservationResponse {
  code: string;
  status: ReservationStatus;
  check_in: string;
  check_out: string;
  guests: number;
  room: { id: number; name: string };
  total_cents: number;
  expires_at: string | null;
}

export interface CreateReservationInput {
  room_id: number;
  check_in: string;
  check_out: string;
  guests: number;
  guest_name: string;
  guest_email: string;
  guest_phone: string;
  notes?: string;
}

export function createReservation(input: CreateReservationInput) {
  return apiFetch<ReservationResponse>("/api/reservations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchReservationByCode(code: string) {
  return apiFetch<ReservationResponse>(`/api/reservations/${encodeURIComponent(code)}`);
}
