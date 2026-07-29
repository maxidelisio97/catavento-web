import { useState } from "react";
import CataventoIcon from "../components/CataventoIcon";
import { ApiError } from "../api/client";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import { TextField } from "../components/ui/Field";

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

        <Card as="form" onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
          <TextField
            id="email"
            label="Email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <TextField
            id="password"
            label="Senha"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {error && (
            <p role="alert" className="text-sm text-danger-500">
              {error}
            </p>
          )}

          <Button type="submit" variant="primary" disabled={loading} className="mt-2 justify-center">
            {loading ? "Entrando..." : "Entrar"}
          </Button>
        </Card>
      </div>
    </div>
  );
}
