import { apiFetch } from "./client";
import type { ReservationDetail } from "./tapeChart";

// Mirrors server/src/plugins/panelManualReservation.ts's `manualReservationBodySchema`
// field-for-field (SDD "Nova reserva" panel change, PR 3a) — field list is
// frozen to exactly what that endpoint accepts today, no scope creep.
export interface CreateManualReservationInput {
  room_id: number;
  check_in: string;
  check_out: string;
  adults: number;
  children?: number;
  children_ages?: number[];
  babies?: number;
  pets?: boolean;
  guest_name: string;
  guest_email?: string;
  guest_phone?: string;
  notes?: string;
  payment_status: "none" | "deposit_paid" | "paid_full";
  payment_method?: "cash" | "external" | "pix_manual";
  override_total_cents?: number;
  force_commercial?: boolean;
  // D1 — always sent as `undefined` from PR 3a: the unit picker (PR 3b) is
  // the only thing that ever sets this. Kept in the type now so PR 3b only
  // has to start populating it, not add a new field end-to-end.
  preferred_room_unit_id?: number;
}

export function createManualReservation(input: CreateManualReservationInput): Promise<ReservationDetail> {
  return apiFetch("/panel/reservations/manual", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
