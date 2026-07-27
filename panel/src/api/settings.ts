import { apiFetch } from "./client";

export interface BusinessSettings {
  deposit_percent: number;
  hold_minutes: number;
  pet_fee_cents: number;
}

export type BusinessSettingsPatch = Partial<BusinessSettings>;

export function getSettings(): Promise<BusinessSettings> {
  return apiFetch("/panel/settings");
}

export function updateSettings(patch: BusinessSettingsPatch): Promise<BusinessSettings> {
  return apiFetch("/panel/settings", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}
