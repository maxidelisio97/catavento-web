import type { PanelRole } from "../api/roles";

// Backend errors come back as bare codes (§ ApiError: body.error), never a
// human message — this maps them to PT-BR copy. LAST_OWNER_LOCKOUT needs the
// real owner role name from data (whatever `roles` has as is_owner=true),
// never a hardcoded literal — the seed happens to name it "Dueño", but this
// must not drift from that value or assume its language.
export function describeAdminError(code: string, roles: PanelRole[]): string {
  const ownerRoleName = roles.find((role) => role.is_owner)?.name ?? "proprietário";

  const messages: Record<string, string> = {
    LAST_OWNER_LOCKOUT: `Essa ação deixaria o painel sem nenhum ${ownerRoleName} ativo. Deve haver sempre pelo menos um.`,
    OWNER_ROLE_NOT_EDITABLE: `O papel ${ownerRoleName} não pode ser editado — ele tem acesso total por definição.`,
    SYSTEM_ROLE_NOT_DELETABLE: "Esse papel é do sistema e não pode ser excluído.",
    ROLE_HAS_ASSIGNED_USERS: "Esse papel tem usuários atribuídos — reatribua-os antes de excluir.",
    EMAIL_ALREADY_EXISTS: "Já existe um usuário com esse e-mail.",
    ROLE_NAME_ALREADY_EXISTS: "Já existe um papel com esse nome.",
    USER_NOT_FOUND: "Usuário não encontrado.",
    ROLE_NOT_FOUND: "Papel não encontrado.",
  };

  return messages[code] ?? "Erro inesperado.";
}
