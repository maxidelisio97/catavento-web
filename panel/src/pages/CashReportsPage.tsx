import { useEffect, useState } from "react";
import {
  getExpenseCategoryReport,
  getLedger,
  getSaleItemReport,
  type ExpenseCategoryReport,
  type Ledger,
  type SaleItemReport,
} from "../api/cash";
import { ApiError } from "../api/client";
import { formatMoneyCents, parseDateUTC, todayISO, formatDateUTC } from "../lib/dateUtils";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import DatePicker from "../components/ui/DatePicker";

function firstOfMonthISO(): string {
  const today = parseDateUTC(todayISO());
  return formatDateUTC(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
}

interface CashReportsPageProps {
  onDone: () => void;
}

// § 6 (10C) — the three reports fused under one date range filter, so they
// always describe the exact same period: the net result (read from the
// ledger's own totals, never recomputed here), expenses by category, and
// sales by product. Changing the range refetches all three together —
// there's no path where one section shows a different period than another.
export default function CashReportsPage({ onDone }: CashReportsPageProps) {
  const [from, setFrom] = useState(firstOfMonthISO());
  const [to, setTo] = useState(todayISO());
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [expenseReport, setExpenseReport] = useState<ExpenseCategoryReport | null>(null);
  const [saleReport, setSaleReport] = useState<SaleItemReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    // Same "cancelled" guard as CashPage.tsx: a slower in-flight request
    // from an earlier render must never clobber a newer one's data.
    let cancelled = false;
    setLoadError(null);
    Promise.all([getLedger(from, to), getExpenseCategoryReport(from, to), getSaleItemReport(from, to)])
      .then(([ledgerData, expenseData, saleData]) => {
        if (cancelled) return;
        setLedger(ledgerData);
        setExpenseReport(expenseData);
        setSaleReport(saleData);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? "Não foi possível carregar os relatórios." : "Erro inesperado.");
      });
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  const totals = ledger?.totals;
  const netPositive = (totals?.net_cents ?? 0) >= 0;

  const expenseCategoryTotal = expenseReport?.categories.reduce((sum, c) => sum + c.total_cents, 0) ?? 0;
  const saleTotalUnits = saleReport?.items.reduce((sum, item) => sum + item.quantity_sold, 0) ?? 0;
  const saleTotalCents = saleReport?.items.reduce((sum, item) => sum + item.total_cents, 0) ?? 0;

  const loaded = ledger && expenseReport && saleReport;

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
      {!loaded && !loadError && <p className="text-sm text-panel-500">Carregando...</p>}

      {loaded && (
        <>
          {/* Resultado do período — same net_cents as the ledger view above
              the book (CashPage.tsx), read straight from its totals, never
              recomputed here. */}
          <Card className="p-5 flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-[11.5px] font-semibold uppercase tracking-wide text-panel-500">
                Resultado do período
              </p>
              <p className={`text-2xl font-semibold ${netPositive ? "text-success-700" : "text-danger-500"}`}>
                {formatMoneyCents(totals!.net_cents)}
              </p>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-panel-600">
              <span>
                Reservas <span className="font-medium text-panel-900">{formatMoneyCents(totals!.reservation_income_cents)}</span>
              </span>
              <span>
                Vendas <span className="font-medium text-panel-900">{formatMoneyCents(totals!.sale_income_cents)}</span>
              </span>
              <span>
                Despesas <span className="font-medium text-panel-900">{formatMoneyCents(totals!.expense_cents)}</span>
              </span>
              <span>
                Reembolsos <span className="font-medium text-panel-900">{formatMoneyCents(totals!.refund_cents)}</span>
              </span>
            </div>
          </Card>

          <div>
            <h3 className="text-[13px] font-semibold text-panel-700 mb-2">Despesas por categoria</h3>
            <div className="bg-white border border-panel-200 rounded-panel-md overflow-hidden">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="bg-panel-50 border-b border-panel-200 text-left text-panel-500">
                    <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Categoria</th>
                    <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {expenseReport.categories.map((cat) => (
                    <tr key={cat.category_id ?? "none"} className="border-b border-panel-150 last:border-b-0 hover:bg-panel-50">
                      <td className="px-4 py-2.5 text-panel-900 font-medium">{cat.name}</td>
                      <td className="px-4 py-2.5 text-right font-medium text-danger-500">
                        {formatMoneyCents(cat.total_cents)}
                      </td>
                    </tr>
                  ))}
                  {expenseReport.categories.length === 0 && (
                    <tr>
                      <td colSpan={2} className="px-4 py-6 text-center text-panel-400">
                        Nenhuma despesa no período.
                      </td>
                    </tr>
                  )}
                </tbody>
                {expenseReport.categories.length > 0 && (
                  <tfoot>
                    <tr className="bg-panel-50 border-t border-panel-200">
                      <td className="px-4 py-2.5 font-semibold text-panel-700">Total</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-danger-500">
                        {formatMoneyCents(expenseCategoryTotal)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          <div>
            <h3 className="text-[13px] font-semibold text-panel-700 mb-2">Vendas por produto</h3>
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
                  {saleReport.items.map((item) => (
                    <tr key={item.sale_item_id} className="border-b border-panel-150 last:border-b-0 hover:bg-panel-50">
                      <td className="px-4 py-2.5 text-panel-900 font-medium">{item.name}</td>
                      <td className="px-4 py-2.5 text-right text-panel-700">{item.quantity_sold}</td>
                      <td className="px-4 py-2.5 text-right font-medium text-success-700">
                        {formatMoneyCents(item.total_cents)}
                      </td>
                    </tr>
                  ))}
                  {saleReport.items.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-4 py-6 text-center text-panel-400">
                        Nenhuma venda de catálogo no período.
                      </td>
                    </tr>
                  )}
                </tbody>
                {saleReport.items.length > 0 && (
                  <tfoot>
                    <tr className="bg-panel-50 border-t border-panel-200">
                      <td className="px-4 py-2.5 font-semibold text-panel-700">Total</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-panel-900">{saleTotalUnits}</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-success-700">
                        {formatMoneyCents(saleTotalCents)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
