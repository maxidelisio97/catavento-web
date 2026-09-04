import { apiFetch } from "./client";

export interface ExpenseCategory {
  id: number;
  name: string;
  active: boolean;
}

export function getExpenseCategories(): Promise<ExpenseCategory[]> {
  return apiFetch("/panel/cash/expense-categories");
}

export function createExpenseCategory(name: string): Promise<ExpenseCategory> {
  return apiFetch("/panel/cash/expense-categories", { method: "POST", body: JSON.stringify({ name }) });
}

export function updateExpenseCategory(
  id: number,
  patch: { name?: string; active?: boolean },
): Promise<ExpenseCategory> {
  return apiFetch(`/panel/cash/expense-categories/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export interface CreateMovementInput {
  kind: "income" | "expense";
  amount_cents: number;
  occurred_on: string;
  description?: string;
  expense_category_id?: number;
  sale_item_id?: number;
  quantity?: number;
  method?: string;
}

export interface CashMovement {
  id: number;
  kind: "income" | "expense";
  amount_cents: number;
  occurred_on: string;
  description: string | null;
  expense_category_id: number | null;
  sale_item_id: number | null;
  quantity: number | null;
  method: string | null;
  created_by: number;
  created_at: string;
}

// § 6 (10B) — sale catalog. No delete: deactivating keeps past sales'
// sale_item_id valid for the per-product report.
export interface SaleItem {
  id: number;
  name: string;
  default_price_cents: number | null;
  active: boolean;
}

export function getSaleItems(): Promise<SaleItem[]> {
  return apiFetch("/panel/cash/sale-items");
}

export function createSaleItem(input: { name: string; default_price_cents?: number }): Promise<SaleItem> {
  return apiFetch("/panel/cash/sale-items", { method: "POST", body: JSON.stringify(input) });
}

export function updateSaleItem(
  id: number,
  patch: { name?: string; default_price_cents?: number | null; active?: boolean },
): Promise<SaleItem> {
  return apiFetch(`/panel/cash/sale-items/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export interface SaleItemReportEntry {
  sale_item_id: number;
  name: string;
  quantity_sold: number;
  total_cents: number;
}

export interface SaleItemReport {
  from: string;
  to: string;
  items: SaleItemReportEntry[];
}

export function getSaleItemReport(from: string, to: string): Promise<SaleItemReport> {
  return apiFetch(`/panel/cash/sale-items/report?from=${from}&to=${to}`);
}

export function createMovement(input: CreateMovementInput): Promise<CashMovement> {
  return apiFetch("/panel/cash/movements", { method: "POST", body: JSON.stringify(input) });
}

export interface LedgerEntry {
  source: "reservation_payment" | "cash_movement";
  kind: "income" | "expense";
  date: string;
  amount_cents: number;
  concept: string;
  method: string | null;
  registered_by: number | null;
  registered_by_name: string | null;
  reservation_id: number | null;
}

export interface LedgerTotals {
  reservation_income_cents: number;
  sale_income_cents: number;
  expense_cents: number;
  refund_cents: number;
  net_cents: number;
}

export interface Ledger {
  from: string;
  to: string;
  entries: LedgerEntry[];
  totals: LedgerTotals;
}

export function getLedger(from: string, to: string): Promise<Ledger> {
  return apiFetch(`/panel/cash/ledger?from=${from}&to=${to}`);
}

// § 6 (10C) — expenses grouped by category. `category_id: null` groups
// every uncategorized expense under "Sem categoria" (server-side, not
// dropped) — see server/src/panel/expensesByCategoryReport.ts.
export interface ExpenseCategoryReportEntry {
  category_id: number | null;
  name: string;
  total_cents: number;
}

export interface ExpenseCategoryReport {
  from: string;
  to: string;
  categories: ExpenseCategoryReportEntry[];
}

export function getExpenseCategoryReport(from: string, to: string): Promise<ExpenseCategoryReport> {
  return apiFetch(`/panel/cash/expense-categories/report?from=${from}&to=${to}`);
}
