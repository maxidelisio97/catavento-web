import { useState } from "react";
import OtaConnectionPage from "./OtaConnectionPage";
import OtaRoomMappingPage from "./OtaRoomMappingPage";

type OtaTab = "conexao" | "mapeamento";

const TABS: { key: OtaTab; label: string }[] = [
  { key: "conexao", label: "Conexão" },
  { key: "mapeamento", label: "Mapeamento" },
];

export default function OtaPage() {
  const [tab, setTab] = useState<OtaTab>("conexao");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 border-b border-panel-200">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`text-[13.5px] font-medium px-3 py-2 -mb-px border-b-2 transition-colors ${
              tab === key
                ? "border-accent-500 text-panel-900"
                : "border-transparent text-panel-500 hover:text-panel-900"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "conexao" && <OtaConnectionPage />}
      {tab === "mapeamento" && <OtaRoomMappingPage />}
    </div>
  );
}
