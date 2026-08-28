import { useEffect, useState } from "react";
import { createRole, updateRole, type PanelRole } from "../api/roles";
import { getPermissionsCatalog, type Permission } from "../api/permissions";
import { ApiError } from "../api/client";
import { describeAdminError } from "../lib/adminErrorMessages";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import { TextField } from "../components/ui/Field";
import PermissionsChecklist from "../components/admin/PermissionsChecklist";

interface RoleFormPageProps {
  role: PanelRole | null;
  roles: PanelRole[];
  onSaved: () => void;
  onCancel: () => void;
}

export default function RoleFormPage({ role, roles, onSaved, onCancel }: RoleFormPageProps) {
  const [catalog, setCatalog] = useState<Permission[] | null>(null);
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPermissionsCatalog()
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch(() => {
        if (!cancelled) setError("Não foi possível carregar o catálogo de permissões.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggle(permission: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(permission);
      else next.delete(permission);
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const permissions = [...selected];
      if (role) {
        await updateRole(role.id, { name, description: description || null, permissions });
      } else {
        await createRole({ name, description: description || undefined, permissions });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? describeAdminError(err.message, roles) : "Erro inesperado ao salvar.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <Card as="form" onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
        <TextField
          id="role-name"
          label="Nome do papel"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          id="role-description"
          label="Descrição"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <div>
          <h2 className="text-[12.5px] font-medium text-panel-700 mb-2">Permissões</h2>
          {!catalog && <p className="text-sm text-panel-500">Carregando...</p>}
          {catalog && (
            <PermissionsChecklist permissions={catalog} selected={selected} onToggle={toggle} />
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm text-danger-500">
            {error}
          </p>
        )}

        <div className="flex gap-2 mt-2">
          <Button type="submit" variant="primary" disabled={saving || !catalog}>
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
