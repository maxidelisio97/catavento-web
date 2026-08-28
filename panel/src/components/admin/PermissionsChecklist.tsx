import type { Permission } from "../../api/permissions";
import { groupPermissions } from "../../lib/permissionGroups";

interface PermissionsChecklistProps {
  permissions: Permission[];
  selected: Set<string>;
  onToggle: (permission: string, checked: boolean) => void;
  disabled?: boolean;
}

export default function PermissionsChecklist({
  permissions,
  selected,
  onToggle,
  disabled,
}: PermissionsChecklistProps) {
  const groups = groupPermissions(permissions);

  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.namespace}>
          <h3 className="text-[11.5px] font-semibold uppercase tracking-wide text-panel-500 mb-1.5">
            {group.label}
          </h3>
          <div className="flex flex-col gap-1.5">
            {group.permissions.map((permission) => (
              <label
                key={permission.key}
                className={`flex items-center gap-2 text-[13px] text-panel-800 ${disabled ? "opacity-50" : "cursor-pointer"}`}
              >
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={selected.has(permission.key)}
                  onChange={(e) => onToggle(permission.key, e.target.checked)}
                  className="h-3.5 w-3.5 rounded-sm border-panel-300 text-accent-500 focus:ring-accent-200"
                />
                {permission.description}
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
