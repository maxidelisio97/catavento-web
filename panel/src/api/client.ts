// Wrapper mínimo de fetch — no se introduce una librería de data-fetching
// nueva para un módulo de dos pantallas (SPEC-modulo-6-panel-base.md §
// 6B.4). `credentials: 'include'` es obligatorio: la sesión vive en una
// cookie HttpOnly, nunca en un header Authorization armado a mano.
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      // Solo declarar JSON cuando de verdad hay body — logout y
      // logout-all son POST sin body, y Fastify rechaza con 400 un
      // Content-Type: application/json sobre un body vacío.
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);

    // SPEC-modulo-6-panel-base.md § 6B.4: "Cualquier respuesta 401 de
    // cualquier endpoint → redirige a login." Un evento global, no un
    // callback pasado a mano, para que esto siga funcionando sin cambios
    // cuando 6C sume endpoints nuevos bajo /panel/* — useSession es el
    // único que escucha esto hoy.
    if (response.status === 401) {
      window.dispatchEvent(new Event("panel:unauthorized"));
    }

    throw new ApiError(response.status, body?.error ?? "Erro inesperado");
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
