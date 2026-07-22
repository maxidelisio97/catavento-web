interface WindowNavProps {
  from: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onJump: (date: string) => void;
}

// SPEC § 6C.2: navegación por semana (no por ventana completa) para
// encabalgar la vista sin perder contexto, más botón "Hoy" y selector de
// fecha para saltar a un período arbitrario.
export default function WindowNav({ from, onPrev, onNext, onToday, onJump }: WindowNavProps) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <button
        type="button"
        onClick={onPrev}
        aria-label="Semana anterior"
        className="px-2 py-1 border border-panel-300 rounded hover:bg-panel-100 text-panel-700"
      >
        ←
      </button>
      <button
        type="button"
        onClick={onNext}
        aria-label="Próxima semana"
        className="px-2 py-1 border border-panel-300 rounded hover:bg-panel-100 text-panel-700"
      >
        →
      </button>
      <button
        type="button"
        onClick={onToday}
        className="px-3 py-1 border border-panel-300 rounded hover:bg-panel-100 text-panel-700 font-medium"
      >
        Hoje
      </button>
      <label className="flex items-center gap-1 text-panel-500 ml-2">
        <span className="sr-only">Ir para data</span>
        <input
          type="date"
          value={from}
          onChange={(e) => e.target.value && onJump(e.target.value)}
          className="border border-panel-300 rounded px-2 py-1 text-panel-900"
        />
      </label>
    </div>
  );
}
