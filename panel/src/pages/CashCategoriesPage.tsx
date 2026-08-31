import { useEffect, useState } from "react";
import { createExpenseCategory, getExpenseCategories, updateExpenseCategory, type ExpenseCategory } from "../api/cash";
import { ApiError } from "../api/client";
import { describeCashError } from "../lib/cashErrorMessages";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import { TextField } from "../components/ui/Field";

interface CashCategoriesPageProps {
  onDone: () => void;
}

export default function CashCategoriesPage({ onDone }: CashCategoriesPageProps) {
  const [categories, setCategories] = useState<ExpenseCategory[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);

  function reload() {
    getExpenseCategories()
      .then(setCategories)
      .catch(() => setLoadError("Não foi possível carregar as categorias."));
  }

  useEffect(reload, []);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setCreateError(null);
    if (!newName.trim()) return;

    setCreating(true);
    try {
      await createExpenseCategory(newName.trim());
      setNewName("");
      reload();
    } catch (err) {
      setCreateError(err instanceof ApiError ? describeCashError(err.message) : "Erro inesperado ao criar.");
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(category: ExpenseCategory) {
    setTogglingId(category.id);
    try {
      await updateExpenseCategory(category.id, { active: !category.active });
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
            id="category-name"
            label="Nova categoria"
            placeholder="Ex.: Fornecedores"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        </div>
        <Button type="submit" variant="primary" disabled={creating}>
          {creating ? "Criando..." : "Criar"}
        </Button>
      </Card>
      {createError && <p className="text-sm text-danger-500">{createError}</p>}

      {loadError && <p className="text-sm text-danger-500">{loadError}</p>}
      {!categories && !loadError && <p className="text-sm text-panel-500">Carregando...</p>}

      {categories && (
        <div className="bg-white border border-panel-200 rounded-panel-md overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-panel-50 border-b border-panel-200 text-left text-panel-500">
                <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Nome</th>
                <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Status</th>
                <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide"></th>
              </tr>
            </thead>
            <tbody>
              {categories.map((cat) => (
                <tr key={cat.id} className="border-b border-panel-150 last:border-b-0 hover:bg-panel-50">
                  <td className="px-4 py-2.5 text-panel-900 font-medium">{cat.name}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={cat.active ? "success" : "neutral"}>{cat.active ? "Ativa" : "Inativa"}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={togglingId === cat.id}
                      onClick={() => handleToggleActive(cat)}
                    >
                      {cat.active ? "Desativar" : "Ativar"}
                    </Button>
                  </td>
                </tr>
              ))}
              {categories.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-panel-400">
                    Nenhuma categoria cadastrada.
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
