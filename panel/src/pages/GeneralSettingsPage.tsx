import { useEffect, useState } from "react";
import { getSettings, updateSettings, type BusinessSettings } from "../api/settings";
import { ApiError } from "../api/client";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import { TextField } from "../components/ui/Field";

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

export default function GeneralSettingsPage() {
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
    return <p className="text-sm text-danger-500">{loadError}</p>;
  }

  if (!form) {
    return <p className="text-sm text-panel-500">Carregando...</p>;
  }

  return (
    <div className="max-w-md">
      <Card as="form" onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
        <TextField
          id="deposit_percent"
          label="Depósito (%)"
          type="number"
          min={0}
          max={100}
          required
          value={form.deposit_percent}
          onChange={(e) => setForm({ ...form, deposit_percent: e.target.value })}
        />

        <TextField
          id="hold_minutes"
          label="Retenção sem pagamento (minutos)"
          type="number"
          min={15}
          required
          value={form.hold_minutes}
          onChange={(e) => setForm({ ...form, hold_minutes: e.target.value })}
        />

        <TextField
          id="pet_fee_reais"
          label="Taxa de animal de estimação (R$/noite)"
          type="number"
          min={0}
          step="0.01"
          required
          value={form.pet_fee_reais}
          onChange={(e) => setForm({ ...form, pet_fee_reais: e.target.value })}
        />

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
    </div>
  );
}
