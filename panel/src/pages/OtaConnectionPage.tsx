import { useEffect, useState } from "react";
import {
  getChannexConfig,
  resyncChannexAvailability,
  testChannexConnection,
  updateChannexConfig,
  type ChannexConfig,
  type ChannexResyncResult,
  type ChannexTestConnectionResult,
} from "../api/channex";
import { ApiError } from "../api/client";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import { TextField } from "../components/ui/Field";

// `environment` is read-only in the panel (SPEC-modulo-12A § 3): it always
// mirrors the server's CHANNEX_ENV, an operator can never point the UI at
// "production" while the backend is still authenticating against staging.
type FormState = { property_id: string; is_active: boolean };

function toFormState(config: ChannexConfig): FormState {
  return { property_id: config.property_id ?? "", is_active: config.is_active };
}

export default function OtaConnectionPage() {
  const [config, setConfig] = useState<ChannexConfig | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const [testResult, setTestResult] = useState<ChannexTestConnectionResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const [resyncResult, setResyncResult] = useState<ChannexResyncResult | null>(null);
  const [resyncError, setResyncError] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getChannexConfig()
      .then((data) => {
        if (cancelled) return;
        setConfig(data);
        setForm(toFormState(data));
      })
      .catch(() => {
        if (!cancelled) setLoadError("Não foi possível carregar a configuração da conexão.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;

    setSaveError(null);
    setSaved(false);
    setSaving(true);
    try {
      const updated = await updateChannexConfig({
        property_id: form.property_id.trim() === "" ? null : form.property_id.trim(),
        is_active: form.is_active,
      });
      setConfig(updated);
      setForm(toFormState(updated));
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Erro inesperado ao salvar.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    setTestError(null);
    setTestResult(null);
    setTesting(true);
    try {
      const result = await testChannexConnection();
      setTestResult(result);
    } catch (err) {
      setTestError(err instanceof ApiError ? err.message : "Erro inesperado ao testar a conexão.");
    } finally {
      setTesting(false);
    }
  }

  async function handleResync() {
    setResyncError(null);
    setResyncResult(null);
    setResyncing(true);
    try {
      const result = await resyncChannexAvailability();
      setResyncResult(result);
    } catch (err) {
      setResyncError(err instanceof ApiError ? err.message : "Erro inesperado ao ressincronizar.");
    } finally {
      setResyncing(false);
    }
  }

  if (loadError) {
    return <p className="text-sm text-danger-500">{loadError}</p>;
  }

  if (!form || !config) {
    return <p className="text-sm text-panel-500">Carregando...</p>;
  }

  return (
    <div className="max-w-md flex flex-col gap-4">
      <Card as="form" onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-medium text-panel-700">Status</span>
            <Badge tone={config.connected ? "success" : "neutral"}>
              {config.connected ? "Conectado" : "Não conectado"}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-medium text-panel-700">Ambiente</span>
            <Badge tone={config.environment === "production" ? "accent" : "neutral"}>
              {config.environment === "production" ? "Produção" : "Staging"}
            </Badge>
          </div>
        </div>

        <TextField
          id="channex_property_id"
          label="Property ID (Channex)"
          value={form.property_id}
          onChange={(e) => setForm({ ...form, property_id: e.target.value })}
          help="UUID da propriedade no Channex."
        />

        <label className="flex items-center gap-2 text-[13.5px] text-panel-700">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
            className="h-4 w-4 rounded border-panel-300 accent-accent-500"
          />
          Conexão ativa
        </label>

        {saveError && (
          <p role="alert" className="text-sm text-danger-500">
            {saveError}
          </p>
        )}
        {saved && !saveError && <p className="text-sm text-success-700">Configuração salva.</p>}

        <Button type="submit" variant="primary" disabled={saving} className="mt-2 justify-center">
          {saving ? "Salvando..." : "Salvar"}
        </Button>
      </Card>

      <Card className="p-6 flex flex-col gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-panel-900">Testar conexão</h2>
          <p className="text-[12.5px] text-panel-500 mt-0.5">
            Verifica a propriedade configurada acima diretamente no Channex.
          </p>
        </div>

        <Button
          variant="secondary"
          disabled={testing || !config.property_id}
          onClick={() => void handleTestConnection()}
        >
          {testing ? "Testando..." : "Testar conexão"}
        </Button>

        {testError && (
          <p role="alert" className="text-sm text-danger-500">
            {testError}
          </p>
        )}
        {testResult && !testError && (
          <p className={`text-sm ${testResult.ok ? "text-success-700" : "text-danger-500"}`}>
            {testResult.ok
              ? `Conexão OK — ${testResult.property?.title ?? testResult.property?.id}`
              : (testResult.error ?? "Falha ao testar a conexão.")}
          </p>
        )}
      </Card>

      <Card className="p-6 flex flex-col gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-panel-900">Ressincronizar disponibilidade</h2>
          <p className="text-[12.5px] text-panel-500 mt-0.5">
            Recalcula e envia disponibilidade e tarifas dos próximos 6 meses para todos os tipos de quarto mapeados.
          </p>
        </div>

        <Button
          variant="secondary"
          disabled={resyncing || !config.connected}
          onClick={() => void handleResync()}
        >
          {resyncing ? "Ressincronizando..." : "Ressincronizar disponibilidade"}
        </Button>

        {resyncError && (
          <p role="alert" className="text-sm text-danger-500">
            {resyncError}
          </p>
        )}
        {resyncResult && !resyncError && (
          <p className="text-sm text-success-700">
            {resyncResult.rooms_pushed} quarto(s) sincronizado(s)
            {resyncResult.rooms_skipped > 0 ? `, ${resyncResult.rooms_skipped} sem mapeamento (ignorado(s))` : ""}.
          </p>
        )}
      </Card>
    </div>
  );
}
