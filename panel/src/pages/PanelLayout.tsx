import { useState } from "react";
import type { PanelUser } from "../api/auth";
import { usePermissions } from "../hooks/usePermissions";
import TapeChartPage from "./TapeChartPage";
import GeneralSettingsPage from "./GeneralSettingsPage";
import RoomRatesTable from "../components/settings/RoomRatesTable";
import RateOverridesCalendar from "../components/settings/RateOverridesCalendar";
import UsersListPage from "./UsersListPage";
import RolesListPage from "./RolesListPage";

interface PanelLayoutProps {
  user: PanelUser;
  onLogout: () => Promise<void>;
  onLogoutAll: () => Promise<void>;
}

type PanelSection = "tape-chart" | "geral" | "precos" | "calendario" | "usuarios" | "papeis";

// Flat items for now, grouped only by a visual divider — once there are
// enough sections under "Configuração" to earn a real submenu, promote this
// to one, but a submenu component for 3 items would be pure ceremony today.
const CONFIG_SECTIONS: { key: PanelSection; label: string }[] = [
  { key: "geral", label: "Geral" },
  { key: "precos", label: "Preços" },
  { key: "calendario", label: "Calendário" },
];

const SECTION_TITLES: Record<Exclude<PanelSection, "tape-chart">, string> = {
  geral: "Geral",
  precos: "Preços",
  calendario: "Calendário",
  usuarios: "Usuários",
  papeis: "Papéis",
};

function NavButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-[13.5px] font-medium px-3 py-1.5 rounded-panel-sm transition-colors ${
        active ? "bg-panel-100 text-panel-900" : "text-panel-500 hover:text-panel-900 hover:bg-panel-100"
      }`}
    >
      {children}
    </button>
  );
}

export default function PanelLayout({ user, onLogout, onLogoutAll }: PanelLayoutProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [section, setSection] = useState<PanelSection>("tape-chart");
  const permissions = usePermissions();

  // § 5/§ 6: narrow, targeted gate for just these two nav items — hiding by
  // permission ahead of 9C's general sweep. Each item gates independently:
  // a user can have admin.users without admin.roles, or vice versa.
  const showUsuarios = permissions.has("admin.users");
  const showPapeis = permissions.has("admin.roles");

  async function handleLogoutAll() {
    setMenuOpen(false);
    // SPEC § 6B.4: "este último con confirmación" — window.confirm alcanza
    // para una acción destructiva de un solo botón; no se justifica un
    // componente de modal propio para este único caso en 6B.
    if (window.confirm("Encerrar a sessão em todos os dispositivos?")) {
      await onLogoutAll();
    }
  }

  return (
    <div className="min-h-dvh bg-panel-50">
      <header className="h-14 border-b border-panel-200 bg-white flex items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <span className="flex items-center gap-2 text-[13px] font-bold text-panel-900 tracking-wide">
            <span className="h-4.5 w-4.5 rounded-[5px] bg-accent-500" aria-hidden="true" />
            CATAVENTO PAINEL
          </span>

          <nav className="flex items-center gap-1">
            <NavButton active={section === "tape-chart"} onClick={() => setSection("tape-chart")}>
              Mapa
            </NavButton>

            <span className="w-px h-5 bg-panel-200 mx-1" aria-hidden="true" />

            {CONFIG_SECTIONS.map(({ key, label }) => (
              <NavButton key={key} active={section === key} onClick={() => setSection(key)}>
                {label}
              </NavButton>
            ))}

            {(showUsuarios || showPapeis) && (
              <>
                <span className="w-px h-5 bg-panel-200 mx-1" aria-hidden="true" />
                {showUsuarios && (
                  <NavButton active={section === "usuarios"} onClick={() => setSection("usuarios")}>
                    Usuários
                  </NavButton>
                )}
                {showPapeis && (
                  <NavButton active={section === "papeis"} onClick={() => setSection("papeis")}>
                    Papéis
                  </NavButton>
                )}
              </>
            )}
          </nav>
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            className="text-[13.5px] font-medium text-panel-700 hover:text-panel-900 hover:bg-panel-100 px-3 py-1.5 rounded-panel-sm transition-colors"
          >
            {user.name}
          </button>

          {menuOpen && (
            <div className="absolute right-0 mt-1 w-56 bg-white border border-panel-200 rounded-panel-md shadow-panel-sm py-1 text-[13.5px]">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  void onLogout();
                }}
                className="w-full text-left px-3 py-2 text-panel-700 hover:bg-panel-100 transition-colors"
              >
                Sair
              </button>
              <button
                type="button"
                onClick={() => void handleLogoutAll()}
                className="w-full text-left px-3 py-2 text-panel-700 hover:bg-panel-100 transition-colors"
              >
                Sair de todos os dispositivos
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="p-6">
        {section === "tape-chart" && <TapeChartPage />}
        {section !== "tape-chart" && (
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight text-panel-900 mb-4">
              {SECTION_TITLES[section]}
            </h1>
            {section === "geral" && <GeneralSettingsPage />}
            {section === "precos" && <RoomRatesTable />}
            {section === "calendario" && <RateOverridesCalendar />}
            {section === "usuarios" && <UsersListPage />}
            {section === "papeis" && <RolesListPage />}
          </div>
        )}
      </main>
    </div>
  );
}
