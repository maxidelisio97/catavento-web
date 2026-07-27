import { useState } from "react";
import type { PanelUser } from "../api/auth";
import TapeChartPage from "./TapeChartPage";
import SettingsPage from "./SettingsPage";

interface PanelLayoutProps {
  user: PanelUser;
  onLogout: () => Promise<void>;
  onLogoutAll: () => Promise<void>;
}

type PanelSection = "tape-chart" | "settings";

export default function PanelLayout({ user, onLogout, onLogoutAll }: PanelLayoutProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [section, setSection] = useState<PanelSection>("tape-chart");

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
          <span className="font-semibold text-panel-900 tracking-wide">CATAVENTO PAINEL</span>

          <nav className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSection("tape-chart")}
              className={`text-sm font-medium px-3 py-1.5 rounded ${
                section === "tape-chart" ? "bg-panel-100 text-panel-900" : "text-panel-500 hover:text-panel-900"
              }`}
            >
              Mapa
            </button>
            <button
              type="button"
              onClick={() => setSection("settings")}
              className={`text-sm font-medium px-3 py-1.5 rounded ${
                section === "settings" ? "bg-panel-100 text-panel-900" : "text-panel-500 hover:text-panel-900"
              }`}
            >
              Configuração
            </button>
          </nav>
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            className="text-sm font-medium text-panel-700 hover:text-panel-900 px-3 py-1.5 rounded"
          >
            {user.name}
          </button>

          {menuOpen && (
            <div className="absolute right-0 mt-1 w-56 bg-white border border-panel-200 rounded-md shadow-lg py-1 text-sm">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  void onLogout();
                }}
                className="w-full text-left px-3 py-2 text-panel-700 hover:bg-panel-100"
              >
                Sair
              </button>
              <button
                type="button"
                onClick={() => void handleLogoutAll()}
                className="w-full text-left px-3 py-2 text-panel-700 hover:bg-panel-100"
              >
                Sair de todos os dispositivos
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="p-6">
        {section === "tape-chart" ? <TapeChartPage /> : <SettingsPage />}
      </main>
    </div>
  );
}
