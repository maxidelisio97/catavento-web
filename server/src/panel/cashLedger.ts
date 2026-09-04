/**
 * GET /panel/cash/ledger — SPEC-modulo-10-caja.md § 3, § 5.1 (entrega 10A).
 *
 * This is the module's central piece: a single query that UNIONs `payments`
 * (received reservation money) with `cash_movements` (manual income/expense)
 * — never a table that copies payment rows. See § 1 ("la caja LEE, no
 * copia") and the plan discussion this implements.
 *
 * Why every payment row lands in exactly one of the three branches below,
 * never zero or two: `payments.kind` is a single column with one value per
 * row (CHECK kind IN ('deposit','balance','extra','refund') — never more
 * than one at a time), so `reservationIncome` (kind IN deposit/balance/extra)
 * and `reservationRefunds` (kind = 'refund') are mutually exclusive by
 * construction — a WHERE-clause partition of the same column, not two
 * independent reads that could both match the same row. `cash_movements`
 * never overlaps `payments` because it's a different table and M10 never
 * writes to `payments`. This is the property `getCashLedger.test` /
 * `panelCashLedger.test.ts`'s "no duplicate" test checks for directly.
 */
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';

export interface CashLedgerEntry {
  source: 'reservation_payment' | 'cash_movement';
  kind: 'income' | 'expense';
  date: string;
  amount_cents: number;
  concept: string;
  method: string | null;
  registered_by: number | null;
  registered_by_name: string | null;
  reservation_id: number | null;
}

export interface CashLedgerTotals {
  reservation_income_cents: number;
  sale_income_cents: number;
  expense_cents: number;
  refund_cents: number;
  net_cents: number;
}

export interface CashLedger {
  from: string;
  to: string;
  entries: CashLedgerEntry[];
  totals: CashLedgerTotals;
}

interface LedgerRow {
  source: 'reservation_payment' | 'cash_movement';
  kind: 'income' | 'expense';
  date: string;
  amount_cents: number;
  concept: string;
  method: string | null;
  registered_by: number | null;
  registered_by_name: string | null;
  reservation_id: number | null;
  source_id: number;
}

export async function getCashLedger(db: Kysely<DB>, input: { from: string; to: string }): Promise<CashLedger> {
  const { from, to } = input;

  // AT TIME ZONE 'UTC' forced explicitly: timestamptz::date alone uses the
  // Postgres SESSION's timezone (never set explicitly anywhere in this
  // repo), which is the exact class of bug M2 already found and documented
  // (src/availability/repository.ts's `date::text` comment) — a payment
  // received near midnight could land on the wrong day depending on
  // whatever timezone the connection happens to negotiate. Every other date
  // in this codebase is UTC-anchored (parseDateUTC/formatDateUTC); the
  // ledger's day boundary matches that, deterministically, regardless of
  // server config.
  const result = await sql<LedgerRow>`
    WITH reservation_income AS (
      SELECT
        'reservation_payment'::text AS source,
        'income'::text AS kind,
        (p.received_at AT TIME ZONE 'UTC')::date AS date,
        p.amount_cents AS amount_cents,
        ('Pagamento de reserva ' || r.code) AS concept,
        p.method AS method,
        p.changed_by AS registered_by,
        p.reservation_id AS reservation_id,
        p.id AS source_id
      FROM payments p
      JOIN reservations r ON r.id = p.reservation_id
      WHERE p.status = 'received'
        AND p.kind IN ('deposit', 'balance', 'extra')
        AND p.received_at IS NOT NULL
        AND (p.received_at AT TIME ZONE 'UTC')::date BETWEEN ${from}::date AND ${to}::date
    ),
    reservation_refunds AS (
      SELECT
        'reservation_payment'::text AS source,
        'expense'::text AS kind,
        (p.received_at AT TIME ZONE 'UTC')::date AS date,
        p.amount_cents AS amount_cents,
        ('Reembolso - reserva ' || r.code) AS concept,
        p.method AS method,
        p.changed_by AS registered_by,
        p.reservation_id AS reservation_id,
        p.id AS source_id
      FROM payments p
      JOIN reservations r ON r.id = p.reservation_id
      WHERE p.status = 'received'
        AND p.kind = 'refund'
        AND p.received_at IS NOT NULL
        AND (p.received_at AT TIME ZONE 'UTC')::date BETWEEN ${from}::date AND ${to}::date
    ),
    movements AS (
      -- § 6 (10B): a catalog sale (sale_item_id set) doesn't require a
      -- typed description — the item name (plus quantity) is a concept on
      -- its own. LEFT JOIN because a free-concept sale and every expense
      -- have no sale_item_id at all. Deactivating a sale item never hides
      -- this: the join is on id, not on active, so a past sale keeps
      -- showing the name of an item that's since been taken off the sell
      -- picker (confirmed with Maxi — history, not a live catalog lookup).
      SELECT
        'cash_movement'::text AS source,
        cm.kind AS kind,
        cm.occurred_on AS date,
        cm.amount_cents AS amount_cents,
        COALESCE(
          NULLIF(cm.description, ''),
          CASE WHEN si.name IS NOT NULL THEN si.name || ' (x' || cm.quantity || ')' END,
          ''
        ) AS concept,
        cm.method AS method,
        cm.created_by AS registered_by,
        NULL::integer AS reservation_id,
        cm.id AS source_id
      FROM cash_movements cm
      LEFT JOIN cash_sale_items si ON si.id = cm.sale_item_id
      WHERE cm.deleted_at IS NULL
        AND cm.occurred_on BETWEEN ${from}::date AND ${to}::date
    ),
    unified AS (
      SELECT * FROM reservation_income
      UNION ALL
      SELECT * FROM reservation_refunds
      UNION ALL
      SELECT * FROM movements
    )
    -- Name resolved server-side (not left to the frontend to look up): a
    -- cash-only operator has cash.view but no admin.users, so they can't
    -- call GET /panel/users to turn a bare id into a name themselves. § 5.2
    -- asks for "quién lo registró" on every line — this is what makes that
    -- possible without widening anyone's permissions.
    SELECT u.source, u.kind, u.date::text AS date, u.amount_cents, u.concept, u.method,
      u.registered_by, usr.name AS registered_by_name, u.reservation_id, u.source_id
    FROM unified u
    LEFT JOIN users usr ON usr.id = u.registered_by
    ORDER BY u.date DESC, u.source_id DESC
  `.execute(db);

  const entries: CashLedgerEntry[] = result.rows.map((row) => ({
    source: row.source,
    kind: row.kind,
    date: row.date,
    amount_cents: row.amount_cents,
    concept: row.concept,
    method: row.method,
    registered_by: row.registered_by,
    registered_by_name: row.registered_by_name,
    reservation_id: row.reservation_id,
  }));

  let reservationIncomeCents = 0;
  let saleIncomeCents = 0;
  let expenseCents = 0;
  let refundCents = 0;

  for (const entry of entries) {
    if (entry.source === 'reservation_payment' && entry.kind === 'income') reservationIncomeCents += entry.amount_cents;
    else if (entry.source === 'reservation_payment' && entry.kind === 'expense') refundCents += entry.amount_cents;
    else if (entry.source === 'cash_movement' && entry.kind === 'income') saleIncomeCents += entry.amount_cents;
    else if (entry.source === 'cash_movement' && entry.kind === 'expense') expenseCents += entry.amount_cents;
  }

  const netCents = reservationIncomeCents + saleIncomeCents - expenseCents - refundCents;

  return {
    from,
    to,
    entries,
    totals: {
      reservation_income_cents: reservationIncomeCents,
      sale_income_cents: saleIncomeCents,
      expense_cents: expenseCents,
      refund_cents: refundCents,
      net_cents: netCents,
    },
  };
}
