import type { Permission } from "../api/permissions";

// Namespace prefix (before the dot) -> PT-BR group header. The permission
// row label itself comes straight from `permissions.description` (already
// PT-BR, seeded in the M9 migration) — no separate label map needed, only
// the group headers, which the catalog doesn't carry.
const GROUP_ORDER = ["reservations", "payments", "config", "admin"] as const;

const GROUP_LABELS: Record<(typeof GROUP_ORDER)[number], string> = {
  reservations: "Reservas",
  payments: "Financeiro",
  config: "Configuração",
  admin: "Administração",
};

export interface PermissionGroup {
  namespace: string;
  label: string;
  permissions: Permission[];
}

export function groupPermissions(permissions: Permission[]): PermissionGroup[] {
  const byNamespace = new Map<string, Permission[]>();
  for (const permission of permissions) {
    const namespace = permission.key.split(".")[0];
    const list = byNamespace.get(namespace) ?? [];
    list.push(permission);
    byNamespace.set(namespace, list);
  }

  const orderedNamespaces = [
    ...GROUP_ORDER.filter((namespace) => byNamespace.has(namespace)),
    ...[...byNamespace.keys()].filter((namespace) => !(GROUP_ORDER as readonly string[]).includes(namespace)),
  ];

  return orderedNamespaces.map((namespace) => ({
    namespace,
    label: GROUP_LABELS[namespace as (typeof GROUP_ORDER)[number]] ?? namespace,
    permissions: byNamespace.get(namespace)!,
  }));
}
