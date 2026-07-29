import { Fragment, useState } from "react";
import type { TapeChartNight, TapeChartResult } from "../../api/tapeChart";
import { dayOfMonth, eachNightUTC, isWeekendNight, shortWeekday, todayISO } from "../../lib/dateUtils";
import { BalanceDueIcon, FragmentedIcon } from "./icons";

interface TapeGridProps {
  data: TapeChartResult;
  onSelectReservation: (reservationId: number) => void;
}

// Initial ratio only — table-layout: fixed uses these to size the "Unidade"
// column against every night column, but once the table is w-full they all
// scale together proportionally. Nothing downstream depends on these being
// the ACTUAL rendered pixel width (see DayTicks below), on purpose: a table
// this size has to stay correct whether the panel is a laptop or an
// ultrawide monitor, not just at the width these were measured at.
const NIGHT_COLUMN_WIDTH = 76;
const UNIT_COLUMN_WIDTH = 72;

// Merged multi-night blocks are one solid color with no cell borders between
// nights — without this, a 5-night bar reads as "occupied for a while," not
// "arrives day X, leaves day Y." Explicit dividers, one per internal night
// boundary, reintroduce that boundary inside the block. Positioned as a
// PERCENTAGE of the button's own rendered width (i / span), not a pixel
// offset — a colSpan'd cell's width is always exactly the sum of whatever
// its spanned <col>s actually rendered at, so `i/span` lands on the real
// boundary regardless of table width, zoom, or viewport. A pixel constant
// would only be correct at the one width it was measured at.
function DayTicks({ span }: { span: number }) {
  if (span <= 1) return null;
  return (
    <>
      {Array.from({ length: span - 1 }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="absolute top-0 bottom-0 w-px bg-white/40"
          style={{ left: `${((i + 1) / span) * 100}%` }}
        />
      ))}
    </>
  );
}

// A run of contiguous nights in the same unit with the same reservation_id
// renders as ONE spanning cell (Booking-style continuous block), not one
// segment per night — reservation_nights is a per-night model server-side,
// but showing "Marina Costa · Marina Costa · Marina Costa" for a single
// 3-night stay reads as three bookings, not one.
interface RowGroup {
  night: string;
  span: number;
  entry: TapeChartNight | null;
  firstEntry: TapeChartNight | null;
  lastEntry: TapeChartNight | null;
}

function buildRowGroups(nights: string[], unitId: number, byKey: Map<string, TapeChartNight>): RowGroup[] {
  const groups: RowGroup[] = [];
  for (const night of nights) {
    const entry = byKey.get(`${unitId}|${night}`) ?? null;
    const last = groups[groups.length - 1];
    if (entry && last?.entry && last.entry.reservation_id === entry.reservation_id) {
      last.span += 1;
      last.lastEntry = entry;
    } else {
      groups.push({ night, span: 1, entry, firstEntry: entry, lastEntry: entry });
    }
  }
  return groups;
}

function headerCellClasses(night: string, isToday: boolean): string {
  const base = "px-2 py-1.5 text-center text-xs font-medium border-b border-r border-panel-200";
  const background = isToday ? "bg-accent-500/10" : isWeekendNight(night) ? "bg-panel-100" : "bg-panel-50";
  const today = isToday ? "text-accent-600 font-semibold" : "text-panel-500";
  return `${base} ${background} ${today}`;
}

// Today's column is a background tint spanning the whole column (header +
// every body cell, occupied or not), not an outline on individual cells —
// an outline drew a visible empty box on every unit that has no reservation
// today, which read as unexplained stray UI rather than a column marker.
// Irrelevant once a reservation block covers the cell (solid bg on top), but
// still matters for the empty cells around it.
//
// border-r on every body cell (occupied or not) is the actual day-boundary
// grid line, running from the header straight through to the bottom row —
// without it a reservation bar has no fixed reference to align against, and
// "which day does this end on" was a guess. It's rendered by the table
// itself off the real column edge, so it can't drift the way a computed
// pixel overlay could.
function bodyCellClasses(night: string, isToday: boolean): string {
  const base = "border-b border-panel-100 border-r border-panel-200 p-0 align-middle";
  const background = isToday ? "bg-accent-500/10" : isWeekendNight(night) ? "bg-panel-100/60" : "";
  return `${base} ${background}`;
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
    <div className="bg-white border border-panel-200 rounded-panel-md overflow-x-auto">
      {/* w-full + table-fixed: the table is free to grow with its container
          (a wider window, a bigger monitor) — every night <col> has the same
          initial width, so table-layout: fixed scales them all by the same
          factor rather than picking favorites. Nothing here depends on the
          *rendered* pixel width matching NIGHT_COLUMN_WIDTH; the grid lines
          are real cell borders (bodyCellClasses/headerCellClasses) and the
          in-block day ticks (DayTicks) are percentages of their own button —
          both track wherever the columns actually end up, at any width. */}
      <table className="border-collapse text-sm w-full table-fixed">
        <colgroup>
          {/* Equal initial widths for every night column — table-layout: fixed
              uses these only to size "Unidade" against a night column and to
              set the ratio between night columns (all equal), then scales
              that ratio to fill w-full. A long guest name can never inflate
              one column and desync it from its header date (see
              server/CLAUDE.md-adjacent bug: table-layout: auto let the widest
              cell in a column stretch it past every other one). A colSpan'd
              reservation block still respects this: fixed layout sums the
              spanned <col> widths, it never lets content re-measure them. */}
          <col style={{ width: UNIT_COLUMN_WIDTH }} />
          {nights.map((night) => (
            <col key={night} style={{ width: NIGHT_COLUMN_WIDTH }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="sticky left-0 z-20 bg-panel-50 border-b border-r border-panel-200 px-2 py-1.5 text-left text-xs font-medium text-panel-500">
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
            const row = buildRowGroups(nights, unit.id, byKey);

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
                  {row.map(({ night, span, entry, firstEntry, lastEntry }) => (
                    <td key={night} colSpan={span} className={bodyCellClasses(night, night === today)}>
                      {entry && (
                        <button
                          type="button"
                          onClick={() => onSelectReservation(entry.reservation_id)}
                          onMouseEnter={() => entry.is_fragmented && setHoveredGroup(entry.fragment_group)}
                          onMouseLeave={() => setHoveredGroup(null)}
                          title={entry.guest_name ?? undefined}
                          className={[
                            "relative flex items-center justify-center gap-1 h-9 w-full px-2 text-[12px] font-medium overflow-hidden",
                            "bg-accent-500 text-white hover:bg-accent-600",
                            "focus:outline-none focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent-200",
                            firstEntry?.is_first_night ? "rounded-l-panel-sm ml-px" : "",
                            lastEntry?.is_last_night ? "rounded-r-panel-sm mr-px" : "",
                            entry.is_fragmented ? "border-2 border-dashed border-warning-500" : "",
                            entry.is_fragmented && hoveredGroup === entry.fragment_group
                              ? "brightness-110 ring-3 ring-warning-500/40"
                              : "",
                          ].join(" ")}
                        >
                          <DayTicks span={span} />
                          {entry.guest_name && <span className="truncate min-w-0">{entry.guest_name}</span>}
                          {entry.has_balance_due && (
                            <span role="img" aria-label="Saldo pendente" className="shrink-0">
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
