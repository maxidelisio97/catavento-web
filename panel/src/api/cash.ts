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
  method?: string;
}

export interface CashMovement {
  id: number;
  kind: "income" | "expense";
  amount_cents: number;
  occurred_on: string;
  description: string | null;
  expense_category_id: number | null;
  method: string | null;
  created_by: number;
  created_at: string;
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
