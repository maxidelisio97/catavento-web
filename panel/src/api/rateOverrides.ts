import { apiFetch, ApiError } from "./client";

export interface RateOverrideRow {
  date: string;
  price_cents: number | null;
  min_stay: number | null;
  closed: boolean;
  units_available: number | null;
}

export interface RateOverridePatch {
  price_cents?: number | null;
  min_stay?: number | null;
  closed?: boolean;
  units_available?: number | null;
}

export function getRateOverrides(roomId: number, from: string, to: string): Promise<RateOverrideRow[]> {
  return apiFetch(`/panel/rate-overrides?room_id=${roomId}&from=${from}&to=${to}`);
}

// SPEC-modulo-8-configuracion.md § 6.4: the 409 body carries `date` /
// `occupied` / `requested` — detail the UI needs to explain the rejection,
// which the shared `ApiError` (message + status only) can't carry. Bypasses
// `apiFetch` for this one call rather than widening `ApiError` for every
// other panel endpoint that never needs this.
export class UnitsAvailableConflictError extends Error {
  constructor(
    readonly date: string,
    readonly occupied: number,
    readonly requested: number,
  ) {
    super(`units_available solicitado (${requested}) é menor que as ${occupied} unidade(s) já ocupadas em ${date}`);
  }
}

export async function putRateOverride(
  roomId: number,
  date: string,
  patch: RateOverridePatch,
): Promise<RateOverrideRow> {
  const response = await fetch("/panel/rate-overrides", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room_id: roomId, date, ...patch }),
  });

  if (response.status === 409) {
    const body = await response.json();
    throw new UnitsAvailableConflictError(body.date, body.occupied, body.requested);
  }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("panel:unauthorized"));
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, body?.error ?? "Erro inesperado");
  }
  return response.json();
}

export interface RangeApplyResult {
  nights: number;
  price_min_stay_closed_applied: boolean;
  units_available: { applied_count: number; failures: { date: string; occupied: number }[] } | null;
}

export function applyRateOverridesRange(
  roomId: number,
  from: string,
  to: string,
  patch: RateOverridePatch,
): Promise<RangeApplyResult> {
  return apiFetch("/panel/rate-overrides/range", {
    method: "PATCH",
    body: JSON.stringify({ room_id: roomId, from, to, ...patch }),
  });
}
