import { Fragment, useState } from "react";
import type { TapeChartNight, TapeChartResult } from "../../api/tapeChart";
import { dayOfMonth, eachNightUTC, isWeekendNight, shortWeekday, todayISO } from "../../lib/dateUtils";
import { BalanceDueIcon, FragmentedIcon } from "./icons";

interface TapeGridProps {
  data: TapeChartResult;
  onSelectReservation: (reservationId: number) => void;
}

interface RowCell {
  night: string;
  entry: TapeChartNight | null;
  showName: boolean;
}

function buildRowCells(nights: string[], unitId: number, byKey: Map<string, TapeChartNight>): RowCell[] {
  let prevReservationId: number | null = null;
  return nights.map((night) => {
    const entry = byKey.get(`${unitId}|${night}`) ?? null;
    const showName = entry != null && entry.reservation_id !== prevReservationId;
    prevReservationId = entry ? entry.reservation_id : null;
    return { night, entry, showName };
  });
}

function headerCellClasses(night: string, isToday: boolean): string {
  const base = "px-2 py-1.5 text-center text-xs font-medium border-b border-panel-200 min-w-14";
  const weekend = isWeekendNight(night) ? "bg-panel-100" : "bg-panel-50";
  const today = isToday ? "text-accent-600 font-semibold" : "text-panel-500";
  return `${base} ${weekend} ${today}`;
}

function bodyCellClasses(night: string, isToday: boolean): string {
  const base = "border-b border-panel-100 p-0 align-middle";
  const weekend = isWeekendNight(night) ? "bg-panel-100/60" : "";
  const today = isToday ? "outline outline-2 outline-offset-[-2px] outline-accent-500/50" : "";
  return `${base} ${weekend} ${today}`;
}

export default function TapeGrid({ data, onSelectReservation }: TapeGridProps) {
  const [hoveredGroup, setHoveredGroup] = useState<number | null>(null);
  const nights = eachNightUTC(data.from, data.to);
  const today = todayISO();

  const byKey = new Map<string, TapeChartNight>();
  for (const n of data.nights) {
    byKey.set(`${n.room_unit_id}|${n.night}`, n);
  }

  return (
    <div className="bg-white border border-panel-200 rounded-lg overflow-x-auto">
      <table className="border-collapse text-sm w-full">
        <thead>
          <tr>
            <th className="sticky left-0 z-20 bg-panel-50 border-b border-r border-panel-200 px-2 py-1.5 text-left text-xs font-medium text-panel-500 min-w-16">
              Unidade
            </th>
            {nights.map((night) => (
              <th key={night} className={headerCellClasses(night, night === today)} scope="col">
                <div>{shortWeekday(night)}</div>
                <div>{dayOfMonth(night)}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.units.map((unit, i) => {
            const isNewGroup = i === 0 || unit.room_type !== data.units[i - 1].room_type;
            const row = buildRowCells(nights, unit.id, byKey);

            return (
              <Fragment key={unit.id}>
                {isNewGroup && (
                  <tr>
                    <th
                      colSpan={nights.length + 1}
                      scope="colgroup"
                      className="sticky left-0 bg-panel-100 text-left text-xs font-semibold text-panel-700 px-2 py-1 border-b border-panel-200"
                    >
                      {unit.room_type}
                    </th>
                  </tr>
                )}
                <tr>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 bg-white border-r border-b border-panel-100 px-2 py-1 text-left text-xs font-medium text-panel-900 whitespace-nowrap"
                  >
                    {unit.label}
                  </th>
                  {row.map(({ night, entry, showName }) => (
                    <td key={night} className={bodyCellClasses(night, night === today)}>
                      {entry && (
                        <button
                          type="button"
                          onClick={() => onSelectReservation(entry.reservation_id)}
                          onMouseEnter={() => entry.is_fragmented && setHoveredGroup(entry.fragment_group)}
                          onMouseLeave={() => setHoveredGroup(null)}
                          title={entry.guest_name ?? undefined}
                          className={[
                            "flex items-center gap-1 h-9 w-full px-1.5 text-xs font-medium overflow-hidden",
                            "bg-accent-500 text-white hover:bg-accent-600",
                            "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-600 focus-visible:ring-offset-1",
                            entry.is_first_night ? "rounded-l-md ml-px" : "",
                            entry.is_last_night ? "rounded-r-md mr-px" : "",
                            entry.is_fragmented ? "border-2 border-dashed border-amber-300" : "",
                            entry.is_fragmented && hoveredGroup === entry.fragment_group
                              ? "brightness-110 ring-2 ring-amber-300"
                              : "",
                          ].join(" ")}
                        >
                          {showName && entry.guest_name && <span className="truncate">{entry.guest_name}</span>}
                          {entry.has_balance_due && (
                            <span role="img" aria-label="Saldo pendente" className="shrink-0 ml-auto">
                              <BalanceDueIcon />
                            </span>
                          )}
                          {entry.is_fragmented && (
                            <span role="img" aria-label="Reserva fragmentada, vinculada a outra unidade" className="shrink-0">
                              <FragmentedIcon />
                            </span>
                          )}
                        </button>
                      )}
                    </td>
                  ))}
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
