import { apiFetch } from "./client";

export interface Permission {
  key: string;
  description: string;
}

export function getPermissionsCatalog(): Promise<Permission[]> {
  return apiFetch("/panel/permissions");
}

export function getMyPermissions(): Promise<{ permissions: string[] }> {
  return apiFetch("/panel/me/permissions");
}
