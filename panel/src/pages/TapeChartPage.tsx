import { useEffect, useMemo, useState } from "react";
import { getTapeChart, type TapeChartResult } from "../api/tapeChart";
import { addDaysUTC, formatDateUTC, parseDateUTC, todayISO } from "../lib/dateUtils";
import SummaryBar from "../components/tapechart/SummaryBar";
import WindowNav from "../components/tapechart/WindowNav";
import TapeGrid from "../components/tapechart/TapeGrid";
import ReservationDrawer from "../components/tapechart/ReservationDrawer";

// SPEC § 6C.5: desktop/tablet mostram 14 noites; abaixo de 768px o mapa de
// 14 colunas fica ilegível, a janela padrão cai para 7.
function useWindowNightsCount(): number {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isMobile ? 7 : 14;
}

export default function TapeChartPage() {
  const windowNights = useWindowNightsCount();
  const [from, setFrom] = useState(todayISO());
  const [data, setData] = useState<TapeChartResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedReservationId, setSelectedReservationId] = useState<number | null>(null);

  const to = useMemo(() => formatDateUTC(addDaysUTC(parseDateUTC(from), windowNights)), [from, windowNights]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getTapeChart(from, to)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => {
        if (!cancelled) setError("Não foi possível carregar o mapa.");
      });
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  return (
    <div className="flex flex-col gap-4">
      <SummaryBar summary={data?.summary ?? null} />

      <WindowNav
        from={from}
        onToday={() => setFrom(todayISO())}
        onPrev={() => setFrom((f) => formatDateUTC(addDaysUTC(parseDateUTC(f), -7)))}
        onNext={() => setFrom((f) => formatDateUTC(addDaysUTC(parseDateUTC(f), 7)))}
        onJump={(date) => setFrom(date)}
      />

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {data && <TapeGrid data={data} onSelectReservation={setSelectedReservationId} />}

      {selectedReservationId != null && (
        <ReservationDrawer reservationId={selectedReservationId} onClose={() => setSelectedReservationId(null)} />
      )}
    </div>
  );
}
