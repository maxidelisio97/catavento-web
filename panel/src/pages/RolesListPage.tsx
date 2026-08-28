import { useEffect, useState } from "react";
import { deleteRole, getRoles, type PanelRole } from "../api/roles";
import { ApiError } from "../api/client";
import { describeAdminError } from "../lib/adminErrorMessages";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import RoleFormPage from "./RoleFormPage";

type View = { mode: "list" } | { mode: "create" } | { mode: "edit"; role: PanelRole };

export default function RolesListPage() {
  const [roles, setRoles] = useState<PanelRole[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ mode: "list" });

  function reload() {
    getRoles()
      .then((data) => setRoles(data))
      .catch(() => setLoadError("Não foi possível carregar os papéis."));
  }

  useEffect(reload, []);

  async function handleDelete(role: PanelRole) {
    setActionError(null);
    if (!window.confirm(`Excluir o papel "${role.name}"?`)) return;

    try {
      await deleteRole(role.id);
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? describeAdminError(err.message, roles ?? []) : "Erro inesperado.");
    }
  }

  if (view.mode === "create") {
    return (
      <RoleFormPage
        role={null}
        roles={roles ?? []}
        onSaved={() => {
          setView({ mode: "list" });
          reload();
        }}
        onCancel={() => setView({ mode: "list" })}
      />
    );
  }

  if (view.mode === "edit") {
    return (
      <RoleFormPage
        role={view.role}
        roles={roles ?? []}
        onSaved={() => {
          setView({ mode: "list" });
          reload();
        }}
        onCancel={() => setView({ mode: "list" })}
      />
    );
  }

  if (loadError) {
    return <p className="text-sm text-danger-500">{loadError}</p>;
  }

  if (!roles) {
    return <p className="text-sm text-panel-500">Carregando...</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => setView({ mode: "create" })}>
          Criar papel
        </Button>
      </div>

      {actionError && (
        <p role="alert" className="text-sm text-danger-500">
          {actionError}
        </p>
      )}

      <div className="bg-white border border-panel-200 rounded-panel-md overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-panel-50 border-b border-panel-200 text-left text-panel-500">
              <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Nome</th>
              <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Descrição</th>
              <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Permissões</th>
              <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide"></th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => (
              <tr key={role.id} className="border-b border-panel-150 last:border-b-0 hover:bg-panel-50">
                <td className="px-4 py-2.5 text-panel-900 font-medium">
                  <span className="flex items-center gap-2">
                    {role.name}
                    {role.is_owner && <Badge tone="accent">Acesso total</Badge>}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-panel-600">{role.description ?? "—"}</td>
                <td className="px-4 py-2.5 text-panel-600">
                  {role.is_owner ? "Todas" : `${role.permissions.length} permissões`}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="inline-flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={role.is_owner}
                      onClick={() => setView({ mode: "edit", role })}
                    >
                      Editar
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={role.is_owner || role.is_system}
                      onClick={() => void handleDelete(role)}
                    >
                      Excluir
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
