import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { login as apiLogin, logout as apiLogout, logoutAll as apiLogoutAll, me, type PanelUser } from "../api/auth";

// Tres estados explícitos, SIN un cuarto implícito de "no sé todavía" que
// se confunda con "unauthenticated": mientras GET /panel/auth/me está en
// vuelo el estado es 'loading', nunca 'unauthenticated'. App.tsx debe
// renderizar un estado neutro (ni login ni layout) durante 'loading' —
// si 'loading' colapsara con 'unauthenticated', cada recarga de página
// mostraría un parpadeo del login antes de entrar al panel.
type SessionState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: PanelUser };

export function useSession() {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const { user } = await me();
      setState({ status: "authenticated", user });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setState({ status: "unauthenticated" });
        return;
      }
      throw err;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Ver el comentario en api/client.ts: cualquier 401 de cualquier
  // endpoint /panel/* (hoy solo auth, mañana también 6C) dispara esto.
  useEffect(() => {
    const onUnauthorized = () => setState({ status: "unauthenticated" });
    window.addEventListener("panel:unauthorized", onUnauthorized);
    return () => window.removeEventListener("panel:unauthorized", onUnauthorized);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { user } = await apiLogin(email, password);
    setState({ status: "authenticated", user });
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setState({ status: "unauthenticated" });
  }, []);

  const logoutAll = useCallback(async () => {
    await apiLogoutAll();
    setState({ status: "unauthenticated" });
  }, []);

  return { ...state, login, logout, logoutAll };
}
