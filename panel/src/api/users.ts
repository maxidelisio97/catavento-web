import { apiFetch } from "./client";

export interface PanelUserAccount {
  id: number;
  email: string;
  name: string;
  role_id: number | null;
  is_active: boolean;
  must_change_password: boolean;
}

export interface CreateUserInput {
  email: string;
  name: string;
  password: string;
  role_id?: number | null;
}

export interface UpdateUserInput {
  name?: string;
  email?: string;
  role_id?: number | null;
  is_active?: boolean;
}

export interface OverrideEntry {
  permission: string;
  granted: boolean | null;
}

export function getUsers(): Promise<PanelUserAccount[]> {
  return apiFetch("/panel/users");
}

export function createUser(input: CreateUserInput): Promise<PanelUserAccount> {
  return apiFetch("/panel/users", { method: "POST", body: JSON.stringify(input) });
}

export function updateUser(id: number, patch: UpdateUserInput): Promise<PanelUserAccount> {
  return apiFetch(`/panel/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function getUserOverrides(id: number): Promise<{ permission: string; granted: boolean }[]> {
  return apiFetch(`/panel/users/${id}/overrides`);
}

export function updateUserOverrides(id: number, overrides: OverrideEntry[]): Promise<void> {
  return apiFetch(`/panel/users/${id}/overrides`, {
    method: "PATCH",
    body: JSON.stringify({ overrides }),
  });
}

export function deactivateUser(id: number): Promise<PanelUserAccount> {
  return apiFetch(`/panel/users/${id}/deactivate`, { method: "POST" });
}
