import { apiFetch } from "./client";

export interface PanelUser {
  id: number;
  name: string;
  email: string;
  role: string;
}

export function login(email: string, password: string): Promise<{ user: PanelUser }> {
  return apiFetch("/panel/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function logout(): Promise<void> {
  return apiFetch("/panel/auth/logout", { method: "POST" });
}

export function logoutAll(): Promise<void> {
  return apiFetch("/panel/auth/logout-all", { method: "POST" });
}

export function me(): Promise<{ user: PanelUser }> {
  return apiFetch("/panel/auth/me");
}
