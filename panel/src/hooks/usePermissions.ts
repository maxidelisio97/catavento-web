import { useEffect, useState } from "react";
import { getMyPermissions } from "../api/permissions";

// Fetched once per panel session (SPEC-modulo-9-usuarios-permisos.md § 6):
// gates only the two admin nav items in 9B. The general "hide every button
// the user can't use" sweep is 9C — this hook is a narrow preview of it.
export function usePermissions() {
  const [permissions, setPermissions] = useState<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMyPermissions()
      .then(({ permissions }) => {
        if (!cancelled) setPermissions(new Set(permissions));
      })
      .catch(() => {
        // Fails closed: an unresolved permission set hides gated nav items
        // rather than showing them (has() below returns false while null).
        if (!cancelled) setPermissions(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    loaded: permissions !== null,
    has: (permission: string) => permissions?.has(permission) ?? false,
  };
}
