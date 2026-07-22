import { useState } from "react";
import CataventoIcon from "../components/CataventoIcon";
import { ApiError } from "../api/client";

interface LoginPageProps {
  onLogin: (email: string, password: string) => Promise<void>;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await onLogin(email, password);
    } catch (err) {
      // SPEC § 6B.3: nunca distinguir "email inexistente" de "contraseña
      // incorrecta" — se muestra el mismo mensaje genérico que devuelve
      // el backend, tanto para 401 como para cualquier otro error.
      const message =
        err instanceof ApiError && err.status === 429
          ? "Muitas tentativas. Aguarde alguns minutos."
          : "Credenciais inválidas";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-panel-50 px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-2 mb-8">
          <CataventoIcon height={48} color="var(--color-panel-900)" />
          <span className="font-semibold tracking-wide text-panel-900">CATAVENTO PAINEL</span>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white border border-panel-200 rounded-lg p-6 flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="email" className="text-sm font-medium text-panel-700">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="border border-panel-300 rounded px-3 py-2 text-sm text-panel-900 focus:outline-none focus:ring-2 focus:ring-accent-500"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="password" className="text-sm font-medium text-panel-700">
              Senha
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="border border-panel-300 rounded px-3 py-2 text-sm text-panel-900 focus:outline-none focus:ring-2 focus:ring-accent-500"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="mt-2 bg-panel-900 text-white text-sm font-medium rounded py-2 hover:bg-panel-700 disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            {loading ? "Entrando..." : "Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
