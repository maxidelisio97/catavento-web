import { useEffect, useState } from "react";
import {
  createUser,
  deactivateUser,
  getUserOverrides,
  updateUser,
  updateUserOverrides,
  type PanelUserAccount,
} from "../api/users";
import { type PanelRole } from "../api/roles";
import { getPermissionsCatalog, type Permission } from "../api/permissions";
import { ApiError } from "../api/client";
import { describeAdminError } from "../lib/adminErrorMessages";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import { TextField, SelectField } from "../components/ui/Field";
import OverridesEditor, { type OverrideState } from "../components/admin/OverridesEditor";

interface UserFormPageProps {
  user: PanelUserAccount | null;
  roles: PanelRole[];
  onSaved: () => void;
  onCancel: () => void;
}

function roleIdToString(roleId: number | null): string {
  return roleId === null ? "" : String(roleId);
}

export default function UserFormPage({ user, roles, onSaved, onCancel }: UserFormPageProps) {
  const [email, setEmail] = useState(user?.email ?? "");
  const [name, setName] = useState(user?.name ?? "");
  const [password, setPassword] = useState("");
  const [roleId, setRoleId] = useState(roleIdToString(user?.role_id ?? null));
  const [isActive, setIsActive] = useState(user?.is_active ?? true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<Permission[] | null>(null);
  const [overrideState, setOverrideState] = useState<Map<string, OverrideState>>(new Map());
  const [overridesSaving, setOverridesSaving] = useState(false);
  const [overridesError, setOverridesError] = useState<string | null>(null);
  const [overridesSaved, setOverridesSaved] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    Promise.all([getPermissionsCatalog(), getUserOverrides(user.id)])
      .then(([permissions, existingOverrides]) => {
        if (cancelled) return;
        setCatalog(permissions);
        const initial = new Map<string, OverrideState>();
        for (const { permission, granted } of existingOverrides) {
          initial.set(permission, granted ? "grant" : "revoke");
        }
        setOverrideState(initial);
      })
      .catch(() => {
        if (!cancelled) setOverridesError("Não foi possível carregar as permissões.");
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  const selectedRole = roles.find((role) => String(role.id) === roleId) ?? null;
  const rolePermissions = new Set(selectedRole?.permissions ?? []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setStatusError(null);
    setSaving(true);
    try {
      if (user) {
        await updateUser(user.id, { name, email, role_id: roleId ? Number(roleId) : null });
      } else {
        await createUser({ email, name, password, role_id: roleId ? Number(roleId) : null });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? describeAdminError(err.message, roles) : "Erro inesperado ao salvar.");
      // A rejected PATCH (e.g. LAST_OWNER_LOCKOUT) must not leave the role
      // selector showing a value that was never actually persisted.
      if (user) setRoleId(roleIdToString(user.role_id));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive() {
    if (!user) return;
    setStatusError(null);
    setError(null);
    try {
      if (isActive) {
        const updated = await deactivateUser(user.id);
        setIsActive(updated.is_active);
      } else {
        const updated = await updateUser(user.id, { is_active: true });
        setIsActive(updated.is_active);
      }
    } catch (err) {
      setStatusError(err instanceof ApiError ? describeAdminError(err.message, roles) : "Erro inesperado.");
    }
  }

  async function handleSaveOverrides() {
    if (!user || !catalog) return;
    setOverridesError(null);
    setOverridesSaved(false);
    setOverridesSaving(true);
    try {
      const overrides = catalog.map((permission) => {
        const state = overrideState.get(permission.key) ?? "inherit";
        return { permission: permission.key, granted: state === "inherit" ? null : state === "grant" };
      });
      await updateUserOverrides(user.id, overrides);
      setOverridesSaved(true);
    } catch (err) {
      setOverridesError(err instanceof ApiError ? describeAdminError(err.message, roles) : "Erro inesperado.");
    } finally {
      setOverridesSaving(false);
    }
  }

  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <Card as="form" onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
        <TextField id="user-name" label="Nome" required value={name} onChange={(e) => setName(e.target.value)} />
        <TextField
          id="user-email"
          label="E-mail"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        {!user && (
          <TextField
            id="user-password"
            label="Senha provisória"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            help="O usuário deverá trocá-la no primeiro login."
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}

        <SelectField id="user-role" label="Papel" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          <option value="">Sem papel</option>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </SelectField>

        {user && (
          <div className="flex items-center gap-3">
            <Badge tone={isActive ? "success" : "neutral"}>{isActive ? "Ativo" : "Inativo"}</Badge>
            <Button type="button" size="sm" variant={isActive ? "danger" : "secondary"} onClick={() => void handleToggleActive()}>
              {isActive ? "Desativar" : "Ativar"}
            </Button>
          </div>
        )}
        {statusError && (
          <p role="alert" className="text-sm text-danger-500">
            {statusError}
          </p>
        )}

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

      {user && (
        <Card className="p-6 flex flex-col gap-4">
          <div>
            <h2 className="text-[15px] font-semibold text-panel-900">Permissões</h2>
            <p className="text-[12.5px] text-panel-500 mt-0.5">
              {selectedRole?.is_owner
                ? `O papel "${selectedRole.name}" tem acesso total por definição — os overrides não têm efeito sobre um Dueño (§ 2.4).`
                : selectedRole
                  ? `O papel "${selectedRole.name}" dá as permissões marcadas com ✓ abaixo. Use os overrides para ajustar caso a caso.`
                  : "Este usuário não tem papel — nenhuma permissão vem do papel. Overrides ainda podem conceder permissões pontuais."}
            </p>
          </div>

          {!selectedRole?.is_owner && !catalog && !overridesError && (
            <p className="text-sm text-panel-500">Carregando...</p>
          )}
          {overridesError && (
            <p role="alert" className="text-sm text-danger-500">
              {overridesError}
            </p>
          )}
          {!selectedRole?.is_owner && catalog && (
            <>
              <OverridesEditor
                permissions={catalog}
                rolePermissions={rolePermissions}
                value={overrideState}
                onChange={(permission, state) =>
                  setOverrideState((prev) => {
                    const next = new Map(prev);
                    next.set(permission, state);
                    return next;
                  })
                }
              />
              <div className="flex items-center gap-3">
                <Button variant="primary" disabled={overridesSaving} onClick={() => void handleSaveOverrides()}>
                  {overridesSaving ? "Salvando..." : "Salvar overrides"}
                </Button>
                {overridesSaved && <span className="text-sm text-success-700">Salvo.</span>}
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
