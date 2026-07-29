import { useEffect, useRef, useState } from "react";
import { DayPicker } from "react-day-picker";
import { ptBR } from "react-day-picker/locale";
import "react-day-picker/style.css";
import { formatDateDisplay } from "../../lib/dateUtils";
import { CalendarIcon } from "./icons";

// react-day-picker reads/writes Date objects via LOCAL calendar fields
// (getDate/getMonth/getFullYear), never UTC — unlike the rest of the panel,
// which deliberately parses every date as UTC midnight (see lib/dateUtils.ts's
// own warning about the "midnight rolls back a day" bug). Handing the picker
// a UTC-midnight Date would let it show the wrong day on any machine not set
// to UTC, which is exactly the bug that convention exists to avoid — so this
// component parses/formats in local time on purpose, and converts back to
// the plain ISO string at its own boundary (onChange), never leaking a local
// Date past this file.
function parseDateLocal(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDateLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

interface DatePickerProps {
  value: string;
  onChange: (date: string) => void;
  label: string;
}

export default function DatePicker({ value, onChange, label }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (!popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const selected = parseDateLocal(value);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={[
          "flex items-center gap-2 border border-panel-300 rounded-panel-sm px-2.5 py-1.5 text-[13px] text-panel-900 bg-white",
          "hover:border-panel-400 transition-colors",
          "focus:outline-none focus-visible:ring-3 focus-visible:ring-accent-100 focus-visible:border-accent-500",
          open ? "border-accent-500 ring-3 ring-accent-100" : "",
        ].join(" ")}
      >
        <span aria-hidden="true" className="text-panel-500">
          <CalendarIcon />
        </span>
        {formatDateDisplay(value)}
      </button>
      <span className="sr-only">{label}</span>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={label}
          className="absolute z-30 right-0 top-full mt-1.5 rounded-panel-md border border-panel-200 bg-white p-2 shadow-panel-md"
        >
          <DayPicker
            mode="single"
            locale={ptBR}
            selected={selected}
            defaultMonth={selected}
            showOutsideDays
            navLayout="around"
            onSelect={(date) => {
              if (!date) return;
              onChange(formatDateLocal(date));
              setOpen(false);
            }}
            className="panel-daypicker"
          />
        </div>
      )}
    </div>
  );
}
