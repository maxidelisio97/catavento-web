import { useEffect, useState } from "react";
import { getUsers, type PanelUserAccount } from "../api/users";
import { getRoles, type PanelRole } from "../api/roles";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import UserFormPage from "./UserFormPage";

type View = { mode: "list" } | { mode: "create" } | { mode: "edit"; user: PanelUserAccount };

export default function UsersListPage() {
  const [users, setUsers] = useState<PanelUserAccount[] | null>(null);
  const [roles, setRoles] = useState<PanelRole[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ mode: "list" });

  function reload() {
    Promise.all([getUsers(), getRoles()])
      .then(([usersData, rolesData]) => {
        setUsers(usersData);
        setRoles(rolesData);
      })
      .catch(() => setLoadError("Não foi possível carregar os usuários."));
  }

  useEffect(reload, []);

  // "Cancelar" also reloads: the active/inactive toggle inside UserFormPage
  // writes immediately via its own endpoint (not the form's Salvar), so
  // leaving via Cancelar after toggling it must not leave the list showing
  // the pre-toggle status from the stale fetch.
  if (view.mode === "create") {
    return (
      <UserFormPage
        user={null}
        roles={roles ?? []}
        onSaved={() => {
          setView({ mode: "list" });
          reload();
        }}
        onCancel={() => {
          setView({ mode: "list" });
          reload();
        }}
      />
    );
  }

  if (view.mode === "edit") {
    return (
      <UserFormPage
        user={view.user}
        roles={roles ?? []}
        onSaved={() => {
          setView({ mode: "list" });
          reload();
        }}
        onCancel={() => {
          setView({ mode: "list" });
          reload();
        }}
      />
    );
  }

  if (loadError) {
    return <p className="text-sm text-danger-500">{loadError}</p>;
  }

  if (!users || !roles) {
    return <p className="text-sm text-panel-500">Carregando...</p>;
  }

  const roleById = new Map(roles.map((role) => [role.id, role]));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => setView({ mode: "create" })}>
          Criar usuário
        </Button>
      </div>

      <div className="bg-white border border-panel-200 rounded-panel-md overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-panel-50 border-b border-panel-200 text-left text-panel-500">
              <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Nome</th>
              <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">E-mail</th>
              <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Papel</th>
              <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Status</th>
              <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const role = user.role_id !== null ? roleById.get(user.role_id) : undefined;

              return (
                <tr key={user.id} className="border-b border-panel-150 last:border-b-0 hover:bg-panel-50">
                  <td className="px-4 py-2.5 text-panel-900 font-medium">{user.name}</td>
                  <td className="px-4 py-2.5 text-panel-600">{user.email}</td>
                  <td className="px-4 py-2.5">
                    {role ? (
                      <Badge tone={role.is_owner ? "accent" : "neutral"}>{role.name}</Badge>
                    ) : (
                      <span className="text-panel-400">Sem papel</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={user.is_active ? "success" : "neutral"}>
                      {user.is_active ? "Ativo" : "Inativo"}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button size="sm" variant="secondary" onClick={() => setView({ mode: "edit", user })}>
                      Editar
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
