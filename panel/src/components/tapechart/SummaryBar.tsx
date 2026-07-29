import type { TapeChartSummary } from "../../api/tapeChart";
import { formatDateDisplay, todayISO } from "../../lib/dateUtils";

interface SummaryBarProps {
  summary: TapeChartSummary | null;
}

// SPEC § 6C.3: always relative to today, with today's date written out
// explicitly — the mapa can be showing any other period, this bar never is.
export default function SummaryBar({ summary }: SummaryBarProps) {
  const occupancyPercent = summary && summary.total_units > 0 ? Math.round((summary.occupied_today / summary.total_units) * 100) : null;

  return (
    <div className="bg-white border border-panel-200 rounded-panel-md px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
      <span className="text-panel-500">Hoje, {formatDateDisplay(todayISO())}</span>
      <span className="text-panel-900">
        <span className="font-semibold">{summary?.arrivals_today ?? "–"}</span> chegam hoje
      </span>
      <span className="text-panel-900">
        <span className="font-semibold">{summary?.departures_today ?? "–"}</span> saem hoje
      </span>
      <span className="text-panel-900">
        Ocupação:{" "}
        <span className="font-semibold">
          {summary ? `${summary.occupied_today}/${summary.total_units}` : "–"}
        </span>
        {occupancyPercent != null && <span className="text-panel-500"> ({occupancyPercent}%)</span>}
      </span>
    </div>
  );
}
