import { useEffect, useState } from "react";
import {
  createMovement,
  getExpenseCategories,
  getSaleItems,
  type ExpenseCategory,
  type SaleItem,
} from "../api/cash";
import { ApiError } from "../api/client";
import { describeCashError } from "../lib/cashErrorMessages";
import { todayISO } from "../lib/dateUtils";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import { TextField, SelectField } from "../components/ui/Field";
import DatePicker from "../components/ui/DatePicker";

const METHOD_OPTIONS: { value: string; label: string }[] = [
  { value: "cash", label: "Dinheiro" },
  { value: "pix_manual", label: "Pix" },
  { value: "external", label: "Outro" },
];

// § 6 (10B) — an income can be a catalog sale (sale_item_id + quantity) or a
// free concept (description only). Kept as an explicit mode so the form
// never sends a half-filled mix of both.
type SaleMode = "catalog" | "free";

interface CashMovementFormPageProps {
  kind: "income" | "expense";
  onSaved: () => void;
  onCancel: () => void;
}

export default function CashMovementFormPage({ kind, onSaved, onCancel }: CashMovementFormPageProps) {
  const [saleMode, setSaleMode] = useState<SaleMode>("catalog");
  const [saleItems, setSaleItems] = useState<SaleItem[] | null>(null);
  const [saleItemsError, setSaleItemsError] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  // Once the operator edits the amount by hand, quantity/item changes stop
  // recalculating it — otherwise a manual discount silently gets clobbered
  // by the next quantity tweak. Reset on item change (a new item starts a
  // fresh auto-priced state) and via the "Recalcular" button.
  const [priceManuallyEdited, setPriceManuallyEdited] = useState(false);

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

  useEffect(() => {
    if (kind !== "income") return;
    let cancelled = false;
    getSaleItems()
      .then((data) => {
        if (!cancelled) setSaleItems(data);
      })
      .catch(() => {
        if (!cancelled) setSaleItemsError("Não foi possível carregar o catálogo.");
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  const selectedItem = saleItems?.find((item) => String(item.id) === selectedItemId) ?? null;

  // Auto-price: recomputes amount from item price × quantity as long as the
  // operator hasn't touched the amount field by hand.
  useEffect(() => {
    if (kind !== "income" || saleMode !== "catalog") return;
    if (priceManuallyEdited) return;
    if (!selectedItem || selectedItem.default_price_cents == null) return;
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) return;
    setAmountReais(((selectedItem.default_price_cents * qty) / 100).toFixed(2));
  }, [kind, saleMode, priceManuallyEdited, selectedItem, quantity]);

  function handleSelectItem(id: string) {
    setSelectedItemId(id);
    setPriceManuallyEdited(false);
    setQuantity("1");
  }

  function handleAmountInput(value: string) {
    setAmountReais(value);
    if (kind === "income" && saleMode === "catalog") setPriceManuallyEdited(true);
  }

  function handleRecalculate() {
    setPriceManuallyEdited(false);
  }

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
    if (kind === "income" && saleMode === "catalog" && !selectedItemId) {
      setError("Selecione um item do catálogo.");
      return;
    }
    const quantityValue = Number(quantity);
    if (kind === "income" && saleMode === "catalog" && (!Number.isInteger(quantityValue) || quantityValue <= 0)) {
      setError("Informe uma quantidade válida.");
      return;
    }
    if (kind === "income" && saleMode === "free" && !description.trim()) {
      setError("Informe uma descrição para a venda.");
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
        sale_item_id: kind === "income" && saleMode === "catalog" ? Number(selectedItemId) : undefined,
        quantity: kind === "income" && saleMode === "catalog" ? quantityValue : undefined,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? describeCashError(err.message) : "Erro inesperado ao salvar.");
    } finally {
      setSaving(false);
    }
  }

  const activeCategories = (categories ?? []).filter((c) => c.active);
  const activeSaleItems = (saleItems ?? []).filter((i) => i.active);

  return (
    <div className="max-w-md">
      <Card as="form" onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
        {kind === "income" && (
          <div className="flex flex-col gap-1">
            <span className="text-[12.5px] font-medium text-panel-700">Tipo de venda</span>
            <div className="inline-flex rounded-panel-sm border border-panel-300 overflow-hidden self-start">
              <button
                type="button"
                onClick={() => setSaleMode("catalog")}
                className={`px-3 py-1.5 text-[13px] font-medium transition-colors ${
                  saleMode === "catalog" ? "bg-accent-500 text-white" : "bg-white text-panel-700 hover:bg-panel-100"
                }`}
              >
                Produto do catálogo
              </button>
              <button
                type="button"
                onClick={() => setSaleMode("free")}
                className={`px-3 py-1.5 text-[13px] font-medium transition-colors border-l border-panel-300 ${
                  saleMode === "free" ? "bg-accent-500 text-white" : "bg-white text-panel-700 hover:bg-panel-100"
                }`}
              >
                Conceito livre
              </button>
            </div>
          </div>
        )}

        {kind === "income" && saleMode === "catalog" && (
          <>
            {saleItemsError && <p className="text-sm text-danger-500">{saleItemsError}</p>}
            <SelectField
              id="movement-sale-item"
              label="Item"
              required
              disabled={!saleItems}
              value={selectedItemId}
              onChange={(e) => handleSelectItem(e.target.value)}
            >
              <option value="">{saleItems ? "Selecione..." : "Carregando..."}</option>
              {activeSaleItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </SelectField>

            <TextField
              id="movement-quantity"
              label="Quantidade"
              type="number"
              min={1}
              step="1"
              required
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </>
        )}

        <TextField
          id="movement-amount"
          label="Valor (R$)"
          type="number"
          min={0.01}
          step="0.01"
          required
          value={amountReais}
          onChange={(e) => handleAmountInput(e.target.value)}
        />

        {kind === "income" && saleMode === "catalog" && priceManuallyEdited && (
          <div className="flex items-center gap-2 -mt-2">
            <span className="text-[11.5px] text-warning-700 bg-warning-50 rounded-full px-2.5 py-0.5 font-medium">
              Valor ajustado manualmente
            </span>
            <button
              type="button"
              onClick={handleRecalculate}
              className="text-[11.5px] text-accent-600 hover:text-accent-700 font-medium underline"
            >
              Recalcular
            </button>
          </div>
        )}

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
          label={kind === "income" && saleMode === "free" ? "Descrição" : "Descrição (opcional)"}
          required={kind === "income" && saleMode === "free"}
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
