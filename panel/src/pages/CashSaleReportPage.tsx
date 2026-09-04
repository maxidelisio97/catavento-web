import { useEffect, useState } from "react";
import { getSaleItemReport, type SaleItemReport } from "../api/cash";
import { ApiError } from "../api/client";
import { formatDateUTC, formatMoneyCents, parseDateUTC, todayISO } from "../lib/dateUtils";
import Button from "../components/ui/Button";
import DatePicker from "../components/ui/DatePicker";

function firstOfMonthISO(): string {
  const today = parseDateUTC(todayISO());
  return formatDateUTC(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
}

interface CashSaleReportPageProps {
  onDone: () => void;
}

export default function CashSaleReportPage({ onDone }: CashSaleReportPageProps) {
  const [from, setFrom] = useState(firstOfMonthISO());
  const [to, setTo] = useState(todayISO());
  const [report, setReport] = useState<SaleItemReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    getSaleItemReport(from, to)
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? "Não foi possível carregar o relatório." : "Erro inesperado.");
      });
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  const totalUnits = report?.items.reduce((sum, item) => sum + item.quantity_sold, 0) ?? 0;
  const totalCents = report?.items.reduce((sum, item) => sum + item.total_cents, 0) ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[12.5px] font-medium text-panel-700">De</span>
            <DatePicker value={from} onChange={setFrom} label="Início do período" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[12.5px] font-medium text-panel-700">Até</span>
            <DatePicker value={to} onChange={setTo} label="Fim do período" />
          </div>
        </div>
        <Button type="button" variant="ghost" onClick={onDone}>
          Voltar ao livro
        </Button>
      </div>

      {loadError && <p className="text-sm text-danger-500">{loadError}</p>}
      {!report && !loadError && <p className="text-sm text-panel-500">Carregando...</p>}

      {report && (
        <div className="bg-white border border-panel-200 rounded-panel-md overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-panel-50 border-b border-panel-200 text-left text-panel-500">
                <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Produto</th>
                <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide text-right">Unidades</th>
                <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {report.items.map((item) => (
                <tr key={item.sale_item_id} className="border-b border-panel-150 last:border-b-0 hover:bg-panel-50">
                  <td className="px-4 py-2.5 text-panel-900 font-medium">{item.name}</td>
                  <td className="px-4 py-2.5 text-right text-panel-700">{item.quantity_sold}</td>
                  <td className="px-4 py-2.5 text-right font-medium text-success-700">
                    {formatMoneyCents(item.total_cents)}
                  </td>
                </tr>
              ))}
              {report.items.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-panel-400">
                    Nenhuma venda de catálogo no período.
                  </td>
                </tr>
              )}
            </tbody>
            {report.items.length > 0 && (
              <tfoot>
                <tr className="bg-panel-50 border-t border-panel-200">
                  <td className="px-4 py-2.5 font-semibold text-panel-700">Total</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-panel-900">{totalUnits}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-success-700">
                    {formatMoneyCents(totalCents)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
