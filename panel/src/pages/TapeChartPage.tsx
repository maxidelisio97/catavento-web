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

interface TapeChartPageProps {
  can: (permission: string) => boolean;
}

export default function TapeChartPage({ can }: TapeChartPageProps) {
  const windowNights = useWindowNightsCount();
  const [from, setFrom] = useState(todayISO());
  const [data, setData] = useState<TapeChartResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedReservationId, setSelectedReservationId] = useState<number | null>(null);
  // Bumped by the drawer after a check-in/check-out/payment so the tape
  // chart's has_balance_due flags and summary stay in sync with the ficha.
  const [refreshKey, setRefreshKey] = useState(0);

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
  }, [from, to, refreshKey]);

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
        <p role="alert" className="text-sm text-danger-500">
          {error}
        </p>
      )}

      {data && <TapeGrid data={data} onSelectReservation={setSelectedReservationId} />}

      {selectedReservationId != null && (
        <ReservationDrawer
          reservationId={selectedReservationId}
          onClose={() => setSelectedReservationId(null)}
          onChanged={() => setRefreshKey((k) => k + 1)}
          can={can}
        />
      )}
    </div>
  );
}
