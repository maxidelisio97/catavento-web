import { useEffect, useState } from "react";
import { createSaleItem, getSaleItems, updateSaleItem, type SaleItem } from "../api/cash";
import { ApiError } from "../api/client";
import { describeCashError } from "../lib/cashErrorMessages";
import { formatMoneyCents } from "../lib/dateUtils";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import { TextField } from "../components/ui/Field";

interface CashSaleItemsPageProps {
  onDone: () => void;
}

export default function CashSaleItemsPage({ onDone }: CashSaleItemsPageProps) {
  const [items, setItems] = useState<SaleItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newPriceReais, setNewPriceReais] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);

  function reload() {
    getSaleItems()
      .then(setItems)
      .catch(() => setLoadError("Não foi possível carregar o catálogo."));
  }

  useEffect(reload, []);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setCreateError(null);
    if (!newName.trim()) return;

    const priceCents = newPriceReais.trim() ? Math.round(Number(newPriceReais) * 100) : undefined;
    if (priceCents !== undefined && (!Number.isFinite(priceCents) || priceCents <= 0)) {
      setCreateError("Informe um preço maior que zero, ou deixe em branco.");
      return;
    }

    setCreating(true);
    try {
      await createSaleItem({ name: newName.trim(), default_price_cents: priceCents });
      setNewName("");
      setNewPriceReais("");
      reload();
    } catch (err) {
      setCreateError(err instanceof ApiError ? describeCashError(err.message) : "Erro inesperado ao criar.");
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(item: SaleItem) {
    setTogglingId(item.id);
    try {
      await updateSaleItem(item.id, { active: !item.active });
      reload();
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4 max-w-lg">
      <Card as="form" onSubmit={handleCreate} className="p-4 flex items-end gap-2">
        <div className="flex-1">
          <TextField
            id="sale-item-name"
            label="Novo item"
            placeholder="Ex.: Cerveja"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        </div>
        <div className="w-28">
          <TextField
            id="sale-item-price"
            label="Preço (R$)"
            type="number"
            min={0.01}
            step="0.01"
            placeholder="Opcional"
            value={newPriceReais}
            onChange={(e) => setNewPriceReais(e.target.value)}
          />
        </div>
        <Button type="submit" variant="primary" disabled={creating}>
          {creating ? "Criando..." : "Criar"}
        </Button>
      </Card>
      {createError && <p className="text-sm text-danger-500">{createError}</p>}

      {loadError && <p className="text-sm text-danger-500">{loadError}</p>}
      {!items && !loadError && <p className="text-sm text-panel-500">Carregando...</p>}

      {items && (
        <div className="bg-white border border-panel-200 rounded-panel-md overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-panel-50 border-b border-panel-200 text-left text-panel-500">
                <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Nome</th>
                <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Preço sugerido</th>
                <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Status</th>
                <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-panel-150 last:border-b-0 hover:bg-panel-50">
                  <td className="px-4 py-2.5 text-panel-900 font-medium">{item.name}</td>
                  <td className="px-4 py-2.5 text-panel-700">
                    {item.default_price_cents != null ? formatMoneyCents(item.default_price_cents) : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={item.active ? "success" : "neutral"}>{item.active ? "Ativo" : "Inativo"}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={togglingId === item.id}
                      onClick={() => handleToggleActive(item)}
                    >
                      {item.active ? "Desativar" : "Ativar"}
                    </Button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-panel-400">
                    Nenhum item cadastrado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <Button type="button" variant="ghost" onClick={onDone}>
          Voltar ao livro
        </Button>
      </div>
    </div>
  );
}
