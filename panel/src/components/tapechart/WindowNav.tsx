import Button from "../ui/Button";
import DatePicker from "../ui/DatePicker";

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
      <Button size="sm" onClick={onPrev} aria-label="Semana anterior">
        ←
      </Button>
      <Button size="sm" onClick={onNext} aria-label="Próxima semana">
        →
      </Button>
      <Button size="sm" onClick={onToday}>
        Hoje
      </Button>
      <span className="ml-2">
        <DatePicker value={from} onChange={onJump} label="Ir para data" />
      </span>
    </div>
  );
}
