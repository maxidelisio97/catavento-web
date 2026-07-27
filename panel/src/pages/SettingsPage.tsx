import { useEffect, useState } from "react";
import { getSettings, updateSettings, type BusinessSettings } from "../api/settings";
import { ApiError } from "../api/client";

// Human-facing units: R$ (not cents) and a plain integer percent — converted
// to the API's cents/integer shape only at submit time (SPEC-modulo-8-configuracion.md § 4.3).
type FormState = { deposit_percent: string; hold_minutes: string; pet_fee_reais: string };

function toFormState(settings: BusinessSettings): FormState {
  return {
    deposit_percent: String(settings.deposit_percent),
    hold_minutes: String(settings.hold_minutes),
    pet_fee_reais: (settings.pet_fee_cents / 100).toFixed(2),
  };
}

export default function SettingsPage() {
  const [form, setForm] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (!cancelled) setForm(toFormState(settings));
      })
      .catch(() => {
        if (!cancelled) setLoadError("Não foi possível carregar a configuração.");
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
      const updated = await updateSettings({
        deposit_percent: Number(form.deposit_percent),
        hold_minutes: Number(form.hold_minutes),
        pet_fee_cents: Math.round(Number(form.pet_fee_reais) * 100),
      });
      setForm(toFormState(updated));
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Erro inesperado ao salvar.");
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return <p className="text-sm text-red-600">{loadError}</p>;
  }

  if (!form) {
    return <p className="text-sm text-panel-500">Carregando...</p>;
  }

  return (
    <div className="max-w-md">
      <h1 className="text-lg font-semibold text-panel-900 mb-4">Configuração</h1>

      <form
        onSubmit={handleSubmit}
        className="bg-white border border-panel-200 rounded-lg p-6 flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="deposit_percent" className="text-sm font-medium text-panel-700">
            Depósito (%)
          </label>
          <input
            id="deposit_percent"
            type="number"
            min={0}
            max={100}
            required
            value={form.deposit_percent}
            onChange={(e) => setForm({ ...form, deposit_percent: e.target.value })}
            className="border border-panel-300 rounded px-3 py-2 text-sm text-panel-900 focus:outline-none focus:ring-2 focus:ring-accent-500"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="hold_minutes" className="text-sm font-medium text-panel-700">
            Retenção sem pagamento (minutos)
          </label>
          <input
            id="hold_minutes"
            type="number"
            min={15}
            required
            value={form.hold_minutes}
            onChange={(e) => setForm({ ...form, hold_minutes: e.target.value })}
            className="border border-panel-300 rounded px-3 py-2 text-sm text-panel-900 focus:outline-none focus:ring-2 focus:ring-accent-500"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="pet_fee_reais" className="text-sm font-medium text-panel-700">
            Taxa de animal de estimação (R$/noite)
          </label>
          <input
            id="pet_fee_reais"
            type="number"
            min={0}
            step="0.01"
            required
            value={form.pet_fee_reais}
            onChange={(e) => setForm({ ...form, pet_fee_reais: e.target.value })}
            className="border border-panel-300 rounded px-3 py-2 text-sm text-panel-900 focus:outline-none focus:ring-2 focus:ring-accent-500"
          />
        </div>

        {saveError && (
          <p role="alert" className="text-sm text-red-600">
            {saveError}
          </p>
        )}
        {saved && !saveError && <p className="text-sm text-green-700">Configuração salva.</p>}

        <button
          type="submit"
          disabled={saving}
          className="mt-2 bg-panel-900 text-white text-sm font-medium rounded py-2 hover:bg-panel-700 disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
        >
          {saving ? "Salvando..." : "Salvar"}
        </button>
      </form>
    </div>
  );
}
