import type { Permission } from "../../api/permissions";
import { groupPermissions } from "../../lib/permissionGroups";
import Badge from "../ui/Badge";

// Per-permission override state as the editor works with it locally:
// "inherit" = no override (role decides), "grant"/"revoke" = explicit
// override. Converted to the API's {granted: true|false|null} shape only at
// save time (null = inherit, i.e. "delete the override row").
export type OverrideState = "inherit" | "grant" | "revoke";

interface OverridesEditorProps {
  permissions: Permission[];
  rolePermissions: Set<string>;
  value: Map<string, OverrideState>;
  onChange: (permission: string, state: OverrideState) => void;
}

function SegmentButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        "px-2 py-1 text-[11.5px] font-medium rounded-panel-sm transition-colors",
        disabled ? "text-panel-300 cursor-not-allowed" : "",
        !disabled && active ? "bg-panel-900 text-white" : "",
        !disabled && !active ? "text-panel-600 hover:bg-panel-100" : "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export default function OverridesEditor({ permissions, rolePermissions, value, onChange }: OverridesEditorProps) {
  const groups = groupPermissions(permissions);

  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.namespace}>
          <h3 className="text-[11.5px] font-semibold uppercase tracking-wide text-panel-500 mb-1.5">
            {group.label}
          </h3>
          <div className="border border-panel-200 rounded-panel-md overflow-hidden">
            {group.permissions.map((permission, index) => {
              const inRole = rolePermissions.has(permission.key);
              const state = value.get(permission.key) ?? "inherit";
              const effective = state === "inherit" ? inRole : state === "grant";

              return (
                <div
                  key={permission.key}
                  className={[
                    "flex items-center justify-between gap-3 px-3 py-2 text-[13px]",
                    index > 0 ? "border-t border-panel-150" : "",
                    effective ? "bg-success-50/40" : "bg-panel-50",
                  ].join(" ")}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={effective ? "text-success-700 font-bold" : "text-panel-300 font-bold"}
                      aria-hidden="true"
                    >
                      {effective ? "✓" : "✗"}
                    </span>
                    <span className={effective ? "text-panel-900" : "text-panel-500"}>{permission.description}</span>
                    {state === "grant" && <Badge tone="accent">+ adicional</Badge>}
                    {state === "revoke" && <Badge tone="warning">− removido</Badge>}
                  </div>

                  <div className="flex items-center gap-0.5 bg-white border border-panel-200 rounded-panel-sm p-0.5 shrink-0">
                    <SegmentButton active={state === "inherit"} onClick={() => onChange(permission.key, "inherit")}>
                      Do papel
                    </SegmentButton>
                    <SegmentButton
                      active={state === "grant"}
                      disabled={inRole}
                      onClick={() => onChange(permission.key, "grant")}
                    >
                      Conceder
                    </SegmentButton>
                    <SegmentButton
                      active={state === "revoke"}
                      disabled={!inRole}
                      onClick={() => onChange(permission.key, "revoke")}
                    >
                      Remover
                    </SegmentButton>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
