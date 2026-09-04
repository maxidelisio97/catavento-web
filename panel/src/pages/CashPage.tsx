import { useEffect, useState } from "react";
import { getLedger, type Ledger, type LedgerEntry } from "../api/cash";
import { ApiError } from "../api/client";
import { formatDateUTC, formatMoneyCents, parseDateUTC, todayISO } from "../lib/dateUtils";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Badge, { type BadgeTone } from "../components/ui/Badge";
import DatePicker from "../components/ui/DatePicker";
import CashMovementFormPage from "./CashMovementFormPage";
import CashCategoriesPage from "./CashCategoriesPage";
import CashSaleItemsPage from "./CashSaleItemsPage";
import CashSaleReportPage from "./CashSaleReportPage";

type View =
  | { mode: "ledger" }
  | { mode: "new-income" }
  | { mode: "new-expense" }
  | { mode: "categories" }
  | { mode: "sale-items" }
  | { mode: "sale-report" };

function firstOfMonthISO(): string {
  const today = parseDateUTC(todayISO());
  return formatDateUTC(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
}

// § 5.2: a reservation payment must read as visually distinct from a manual
// sale/expense — the badge label carries that distinction, kind carries the
// entrada/salida color.
function describeSource(entry: LedgerEntry): { label: string; tone: BadgeTone } {
  if (entry.source === "reservation_payment") {
    return entry.kind === "income" ? { label: "Reserva", tone: "accent" } : { label: "Reembolso", tone: "danger" };
  }
  return entry.kind === "income" ? { label: "Venda avulsa", tone: "success" } : { label: "Despesa", tone: "danger" };
}

function registeredByLabel(entry: LedgerEntry): string {
  if (entry.registered_by_name) return entry.registered_by_name;
  // A reservation payment confirmed by the Asaas webhook has no operator —
  // nobody "registered" it, the payment gateway did.
  if (entry.source === "reservation_payment") return "Asaas";
  return "—";
}

interface CashPageProps {
  can: (permission: string) => boolean;
}

export default function CashPage({ can }: CashPageProps) {
  const [view, setView] = useState<View>({ mode: "ledger" });
  const [from, setFrom] = useState(firstOfMonthISO());
  const [to, setTo] = useState(todayISO());
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped to force a re-fetch (e.g. after saving a movement) without
  // duplicating the fetch logic below or racing the effect that already
  // owns it — see the `cancelled` guard's own comment for why a second,
  // independent fetch call (calling a `reload()` defined outside the effect)
  // is exactly the bug this avoids.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    // Without this, a slower in-flight request from an earlier render (e.g.
    // React StrictMode's dev-only double effect on mount) can resolve AFTER
    // a newer one and overwrite fresh data with stale data — observed for
    // real while verifying this page: creating a movement reloaded
    // correctly per the network tab, but the table kept showing the
    // pre-movement totals because an older, still-pending initial fetch
    // landed last and clobbered the just-set state.
    let cancelled = false;
    setLoadError(null);
    getLedger(from, to)
      .then((data) => {
        if (!cancelled) setLedger(data);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? "Não foi possível carregar o livro." : "Erro inesperado.");
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, refreshKey]);

  function reload() {
    setRefreshKey((key) => key + 1);
  }

  if (view.mode === "new-income") {
    return (
      <CashMovementFormPage
        kind="income"
        onSaved={() => {
          setView({ mode: "ledger" });
          reload();
        }}
        onCancel={() => setView({ mode: "ledger" })}
      />
    );
  }

  if (view.mode === "new-expense") {
    return (
      <CashMovementFormPage
        kind="expense"
        onSaved={() => {
          setView({ mode: "ledger" });
          reload();
        }}
        onCancel={() => setView({ mode: "ledger" })}
      />
    );
  }

  if (view.mode === "categories") {
    return <CashCategoriesPage onDone={() => setView({ mode: "ledger" })} />;
  }

  if (view.mode === "sale-items") {
    return <CashSaleItemsPage onDone={() => setView({ mode: "ledger" })} />;
  }

  if (view.mode === "sale-report") {
    return <CashSaleReportPage onDone={() => setView({ mode: "ledger" })} />;
  }

  const totals = ledger?.totals;
  const netPositive = (totals?.net_cents ?? 0) >= 0;

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

        <div className="flex gap-2">
          {can("cash.income") && (
            <Button variant="primary" onClick={() => setView({ mode: "new-income" })}>
              Novo ingresso
            </Button>
          )}
          {can("cash.expense") && (
            <Button variant="secondary" onClick={() => setView({ mode: "new-expense" })}>
              Novo egresso
            </Button>
          )}
          {can("cash.view") && (
            <Button variant="ghost" onClick={() => setView({ mode: "sale-report" })}>
              Relatório por produto
            </Button>
          )}
          {can("cash.manage") && (
            <Button variant="ghost" onClick={() => setView({ mode: "sale-items" })}>
              Catálogo
            </Button>
          )}
          {can("cash.manage") && (
            <Button variant="ghost" onClick={() => setView({ mode: "categories" })}>
              Categorias
            </Button>
          )}
        </div>
      </div>

      {loadError && <p className="text-sm text-danger-500">{loadError}</p>}

      {!ledger && !loadError && <p className="text-sm text-panel-500">Carregando...</p>}

      {ledger && totals && (
        <>
          <Card className="p-5 flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-[11.5px] font-semibold uppercase tracking-wide text-panel-500">
                Saldo do período
              </p>
              <p className={`text-2xl font-semibold ${netPositive ? "text-success-700" : "text-danger-500"}`}>
                {formatMoneyCents(totals.net_cents)}
              </p>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-panel-600">
              <span>
                Reservas <span className="font-medium text-panel-900">{formatMoneyCents(totals.reservation_income_cents)}</span>
              </span>
              <span>
                Vendas <span className="font-medium text-panel-900">{formatMoneyCents(totals.sale_income_cents)}</span>
              </span>
              <span>
                Despesas <span className="font-medium text-panel-900">{formatMoneyCents(totals.expense_cents)}</span>
              </span>
              <span>
                Reembolsos <span className="font-medium text-panel-900">{formatMoneyCents(totals.refund_cents)}</span>
              </span>
            </div>
          </Card>

          <div className="bg-white border border-panel-200 rounded-panel-md overflow-hidden">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-panel-50 border-b border-panel-200 text-left text-panel-500">
                  <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Data</th>
                  <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Origem</th>
                  <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Conceito</th>
                  <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide text-right">Valor</th>
                  <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Método</th>
                  <th className="px-4 py-2.5 font-semibold text-[11.5px] uppercase tracking-wide">Registrado por</th>
                </tr>
              </thead>
              <tbody>
                {ledger.entries.map((entry, i) => {
                  const source = describeSource(entry);
                  return (
                    <tr key={i} className="border-b border-panel-150 last:border-b-0 hover:bg-panel-50">
                      <td className="px-4 py-2.5 text-panel-700">{formatDateUTC(parseDateUTC(entry.date))}</td>
                      <td className="px-4 py-2.5">
                        <Badge tone={source.tone}>{source.label}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-panel-900">{entry.concept}</td>
                      <td
                        className={`px-4 py-2.5 text-right font-medium ${
                          entry.kind === "income" ? "text-success-700" : "text-danger-500"
                        }`}
                      >
                        {entry.kind === "income" ? "+" : "−"} {formatMoneyCents(entry.amount_cents)}
                      </td>
                      <td className="px-4 py-2.5 text-panel-600">{entry.method ?? "—"}</td>
                      <td className="px-4 py-2.5 text-panel-600">{registeredByLabel(entry)}</td>
                    </tr>
                  );
                })}
                {ledger.entries.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-panel-400">
                      Nenhum movimento no período.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
