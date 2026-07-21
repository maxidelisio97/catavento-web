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
  adultsOnly: boolean;
  available: boolean;
  units_left: number;
  total_units: number;
  total_cents: number | null;
  min_stay_ok: boolean;
}

export interface AvailabilityResponse {
  check_in: string;
  check_out: string;
  guests: number;
  rooms: AvailabilityRoom[];
}

export function fetchAvailability(params: {
  checkIn: string;
  checkOut: string;
  adults: number;
  children?: number;
  babies?: number;
}) {
  const search = new URLSearchParams({
    check_in: params.checkIn,
    check_out: params.checkOut,
    adults: String(params.adults),
  });
  if (params.children) search.set("children", String(params.children));
  if (params.babies) search.set("babies", String(params.babies));
  return apiFetch<AvailabilityResponse>(`/api/availability?${search.toString()}`);
}

export type ReservationStatus =
  | "pending_payment"
  | "confirmed"
  | "cancelled"
  | "expired"
  | "payment_conflict";

export type PaymentStatus = "pending" | "received" | "failed" | "refunded";

export interface ReservationPaymentPix {
  encoded_image: string;
  payload: string;
  expiration_date: string;
}

export interface ReservationPayment {
  method: "pix" | "card";
  pix?: ReservationPaymentPix;
  invoice_url?: string;
}

export interface ReservationResponse {
  code: string;
  status: ReservationStatus;
  check_in: string;
  check_out: string;
  guests: number;
  // Só vêm no 201 de criação (o hóspede vê uma vez); o GET público por
  // código nunca os expõe — não são um segredo forte (viaja por WhatsApp,
  // vira print) e ninguém precisa saber quantas crianças/idades ali.
  children?: number;
  babies?: number;
  children_ages?: number[];
  room: { id: number; name: string };
  total_cents: number;
  deposit_cents: number | null;
  expires_at: string | null;
  payment_status: PaymentStatus | null;
  payment: ReservationPayment | null;
}

export interface CreateReservationInput {
  room_id: number;
  check_in: string;
  check_out: string;
  adults: number;
  children?: number;
  babies?: number;
  childrenAges?: number[];
  guest_name: string;
  guest_email: string;
  guest_phone: string;
  notes?: string;
}

export function createReservation(input: CreateReservationInput) {
  const { childrenAges, ...rest } = input;
  return apiFetch<ReservationResponse>("/api/reservations", {
    method: "POST",
    body: JSON.stringify({ ...rest, children_ages: childrenAges ?? [] }),
  });
}

export function fetchReservationByCode(code: string) {
  return apiFetch<ReservationResponse>(`/api/reservations/${encodeURIComponent(code)}`);
}

export interface RequestPaymentInput {
  method: "pix" | "card";
  cpf_cnpj: string;
}

export type RequestPaymentResponse =
  | { method: "pix"; payment_id: string; qr_code: ReservationPaymentPix }
  | { method: "card"; payment_id: string; invoice_url: string };

export function requestPayment(code: string, input: RequestPaymentInput) {
  return apiFetch<RequestPaymentResponse>(`/api/reservations/${encodeURIComponent(code)}/payment`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
