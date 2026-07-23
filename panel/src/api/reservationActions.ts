import { apiFetch } from "./client";

export type PanelPaymentKind = "deposit" | "balance" | "extra";
export type PanelPaymentMethod = "asaas_pix" | "asaas_card" | "cash" | "external" | "pix_manual";

export interface RegisterPaymentInput {
  kind: PanelPaymentKind;
  method: PanelPaymentMethod;
  amount_cents: number;
  cpf_cnpj?: string;
  /** Required for cash/external/pix_manual — generate once per payment-form session (on open, not on submit) so retries of the same intent dedupe server-side. */
  idempotency_key?: string;
}

export type RegisterPaymentResult =
  | { method: "pix"; payment_id: string; qr_code: { encoded_image: string; payload: string; expiration_date: string } }
  | { method: "card"; payment_id: string; invoice_url: string }
  | { method: "cash" | "external" | "pix_manual"; payment_id: number; status: "received" };

export function registerPayment(code: string, input: RegisterPaymentInput): Promise<RegisterPaymentResult> {
  return apiFetch(`/panel/reservations/${code}/payment`, { method: "POST", body: JSON.stringify(input) });
}

export function checkIn(code: string): Promise<{ status: "checked_in" }> {
  return apiFetch(`/panel/reservations/${code}/check-in`, { method: "POST" });
}

export function checkOut(code: string): Promise<{ status: "checked_out" }> {
  return apiFetch(`/panel/reservations/${code}/check-out`, { method: "POST" });
}
