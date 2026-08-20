import { LuMinus, LuPlus } from "react-icons/lu";

type GuestCounterRowProps = {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
};

export default function GuestCounterRow({ label, hint, value, min, max, onChange }: GuestCounterRowProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="font-body text-sm font-medium text-madera">{label}</p>
        <p className="font-body text-xs text-ink/55">{hint}</p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label={`Diminuir ${label.toLowerCase()}`}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - 1))}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-pill-border text-ink transition-colors hover:border-terracota hover:text-terracota disabled:cursor-not-allowed disabled:opacity-30"
        >
          <LuMinus size={14} />
        </button>
        <span className="w-4 text-center font-body text-sm font-semibold tabular-nums text-madera">{value}</span>
        <button
          type="button"
          aria-label={`Aumentar ${label.toLowerCase()}`}
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + 1))}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-pill-border text-ink transition-colors hover:border-terracota hover:text-terracota disabled:cursor-not-allowed disabled:opacity-30"
        >
          <LuPlus size={14} />
        </button>
      </div>
    </div>
  );
}
