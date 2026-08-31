import { useEffect, useState } from "react";
import { createMovement, getExpenseCategories, type ExpenseCategory } from "../api/cash";
import { ApiError } from "../api/client";
import { describeCashError } from "../lib/cashErrorMessages";
import { todayISO } from "../lib/dateUtils";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import { TextField, SelectField } from "../components/ui/Field";
import DatePicker from "../components/ui/DatePicker";

// § 5.2 — 10A only has the manual/free-form paths. The catalog-driven sale
// (pick a product, quantity, suggested price) is 10B (cash_sale_items
// doesn't exist yet) — this form never references it.
const METHOD_OPTIONS: { value: string; label: string }[] = [
  { value: "cash", label: "Dinheiro" },
  { value: "pix_manual", label: "Pix" },
  { value: "external", label: "Outro" },
];

interface CashMovementFormPageProps {
  kind: "income" | "expense";
  onSaved: () => void;
  onCancel: () => void;
}

export default function CashMovementFormPage({ kind, onSaved, onCancel }: CashMovementFormPageProps) {
  const [amountReais, setAmountReais] = useState("");
  const [occurredOn, setOccurredOn] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [method, setMethod] = useState("");
  const [expenseCategoryId, setExpenseCategoryId] = useState("");
  const [categories, setCategories] = useState<ExpenseCategory[] | null>(null);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "expense") return;
    let cancelled = false;
    getExpenseCategories()
      .then((data) => {
        if (!cancelled) setCategories(data);
      })
      .catch(() => {
        if (!cancelled) setCategoriesError("Não foi possível carregar as categorias.");
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const amountCents = Math.round(Number(amountReais) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setError("Informe um valor maior que zero.");
      return;
    }
    if (kind === "expense" && !expenseCategoryId) {
      setError("Selecione uma categoria.");
      return;
    }

    setSaving(true);
    try {
      await createMovement({
        kind,
        amount_cents: amountCents,
        occurred_on: occurredOn,
        description: description || undefined,
        method: method || undefined,
        expense_category_id: kind === "expense" ? Number(expenseCategoryId) : undefined,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? describeCashError(err.message) : "Erro inesperado ao salvar.");
    } finally {
      setSaving(false);
    }
  }

  const activeCategories = (categories ?? []).filter((c) => c.active);

  return (
    <div className="max-w-md">
      <Card as="form" onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
        <TextField
          id="movement-amount"
          label="Valor (R$)"
          type="number"
          min={0.01}
          step="0.01"
          required
          value={amountReais}
          onChange={(e) => setAmountReais(e.target.value)}
        />

        <div className="flex flex-col gap-1">
          <span className="text-[12.5px] font-medium text-panel-700">Data</span>
          <DatePicker value={occurredOn} onChange={setOccurredOn} label="Data do movimento" />
        </div>

        {kind === "expense" && (
          <>
            {categoriesError && <p className="text-sm text-danger-500">{categoriesError}</p>}
            <SelectField
              id="movement-category"
              label="Categoria"
              required
              disabled={!categories}
              value={expenseCategoryId}
              onChange={(e) => setExpenseCategoryId(e.target.value)}
            >
              <option value="">{categories ? "Selecione..." : "Carregando..."}</option>
              {activeCategories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </SelectField>
          </>
        )}

        <TextField
          id="movement-description"
          label="Descrição"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <SelectField
          id="movement-method"
          label="Método"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
        >
          <option value="">Não informado</option>
          {METHOD_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </SelectField>

        {error && (
          <p role="alert" className="text-sm text-danger-500">
            {error}
          </p>
        )}

        <div className="flex gap-2 mt-2">
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? "Salvando..." : "Salvar"}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </Card>
    </div>
  );
}
