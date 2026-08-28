import { apiFetch } from "./client";

export interface PanelRole {
  id: number;
  name: string;
  description: string | null;
  is_system: boolean;
  is_owner: boolean;
  permissions: string[];
}

export interface CreateRoleInput {
  name: string;
  description?: string;
  permissions?: string[];
}

export interface UpdateRoleInput {
  name?: string;
  description?: string | null;
  permissions?: string[];
}

export function getRoles(): Promise<PanelRole[]> {
  return apiFetch("/panel/roles");
}

export function createRole(input: CreateRoleInput): Promise<PanelRole> {
  return apiFetch("/panel/roles", { method: "POST", body: JSON.stringify(input) });
}

export function updateRole(id: number, patch: UpdateRoleInput): Promise<PanelRole> {
  return apiFetch(`/panel/roles/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteRole(id: number): Promise<void> {
  return apiFetch(`/panel/roles/${id}`, { method: "DELETE" });
}
