/**
 * GET/POST /panel/cash/expense-categories, PATCH .../:id,
 * GET/POST/PATCH/DELETE /panel/cash/movements (hybrid sale via
 * sale_item_id + quantity, or free-concept via description),
 * GET/POST/PATCH /panel/cash/sale-items, GET .../sale-items/report —
 * SPEC-modulo-10-caja.md § 5.1 (entrega 10A, libro base) and § 6 (entrega
 * 10B, catálogo híbrido — complete: catalog CRUD, hybrid sale, per-product
 * report).
 *
 * Does NOT include GET /panel/cash/ledger's own file (§ 3, the unified
 * read of `payments` + `cash_movements`) — that logic lives in
 * panel/cashLedger.ts, this file only wires its route.
 */
import type { FastifyError, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { requireAuth } from '../auth/requireAuth.js';
import { blockIfMustChangePassword } from '../auth/blockIfMustChangePassword.js';
import { requireAnyPermission, requirePermission } from '../auth/requirePermission.js';
import { can } from '../permissions/effectivePermissions.js';
import { getEffectivePermissionInput } from '../permissions/permissionRepository.js';
import { formatDateUTC, parseDateUTC } from '../shared/dateUtils.js';
import { getCashLedger } from '../panel/cashLedger.js';
import { getSalesByItemReport } from '../panel/salesByItemReport.js';
import { getExpensesByCategoryReport } from '../panel/expensesByCategoryReport.js';

// Calendar-validating, not just format — § 8: "no repetir el bug del
// dateSchema" (server/CLAUDE.md documents the regex-only version accepting
// 2026-13-45 and blowing up as a raw 500 at the ::date cast). parseDateUTC
// silently rolls an out-of-range month/day into a different date instead of
// throwing, so the roundtrip-through-formatDateUTC comparison is what
// actually catches it: an invalid date never formats back to its own input.
const occurredOnSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((value) => formatDateUTC(parseDateUTC(value)) === value, { message: 'Invalid calendar date' });

const categoryResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  active: z.boolean(),
});

const createCategoryBodySchema = z.object({ name: z.string().min(1) });

const patchCategoryBodySchema = z
  .object({ name: z.string().min(1).optional(), active: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, { message: 'Body must include at least one field' });

// § 6 (10B) — the sale catalog. No DELETE: deactivating (not removing) an
// item keeps `cash_movements.sale_item_id` valid for past sales — the
// per-product report must keep showing units sold with an item that's since
// been taken off the sell picker (confirmed with Maxi before implementing).
const saleItemResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  default_price_cents: z.number().nullable(),
  active: z.boolean(),
});

const createSaleItemBodySchema = z.object({
  name: z.string().min(1),
  default_price_cents: z.number().int().positive().optional(),
});

const patchSaleItemBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    default_price_cents: z.number().int().positive().nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Body must include at least one field' });

const movementResponseSchema = z.object({
  id: z.number(),
  kind: z.enum(['income', 'expense']),
  amount_cents: z.number(),
  occurred_on: z.string(),
  description: z.string().nullable(),
  expense_category_id: z.number().nullable(),
  sale_item_id: z.number().nullable(),
  quantity: z.number().nullable(),
  method: z.string().nullable(),
  created_by: z.number(),
  created_at: z.string(),
});

// § 6 (10B) — the hybrid sale: sale_item_id + quantity picks from the
// catalog (cash_sale_items), amount_cents is what it actually sold for —
// the catalog's default_price_cents is only a form default the frontend
// pre-fills, re-editable before saving. amount_cents is what's stored and
// is what the per-product report will sum; it's never recomputed from
// default_price_cents × quantity later, so a future catalog price change
// can't reshape a past sale's numbers (confirmed with Maxi — same "precio
// congelado" principle as reservation pricing). No sale_item_id + a
// description = the free-concept path, unchanged from 10A.
//
// § 5.2: an expense's form has a category select; a sale (income) form has
// either a catalog pick or a free concept — so both expense_category_id and
// sale_item_id are tied to kind, not left to caller judgment. sale_item_id
// and quantity are always provided as a pair (also enforced by the DB
// constraint cash_movements_sale_item_quantity_check as the source of
// truth) — the report by product depends on quantity, so it's never one
// without the other.
const createMovementBodySchema = z
  .object({
    kind: z.enum(['income', 'expense']),
    amount_cents: z.number().int().positive(),
    occurred_on: occurredOnSchema,
    description: z.string().optional(),
    expense_category_id: z.number().int().positive().optional(),
    sale_item_id: z.number().int().positive().optional(),
    quantity: z.number().int().positive().optional(),
    method: z.string().optional(),
  })
  .refine((body) => body.kind === 'expense' || body.expense_category_id === undefined, {
    message: 'expense_category_id is only valid for kind=expense',
  })
  .refine((body) => body.kind === 'income' || body.expense_category_id !== undefined, {
    message: 'expense_category_id is required for kind=expense',
  })
  .refine((body) => body.kind === 'income' || body.sale_item_id === undefined, {
    message: 'sale_item_id is only valid for kind=income',
  })
  .refine((body) => (body.sale_item_id === undefined) === (body.quantity === undefined), {
    message: 'sale_item_id and quantity must be provided together',
  });

// Editing a movement's kind is out of scope — a mis-entered movement is
// soft-deleted and re-created, not flipped from income to expense in place.
// sale_item_id/quantity ARE patchable (correcting a mis-picked item or a
// wrong quantity is a normal edit, same as amount_cents) — the pairing rule
// isn't re-validated here at the Zod layer because a PATCH is partial by
// design (e.g. quantity alone, leaving an already-set sale_item_id as-is);
// the DB constraint is the actual source of truth and its 23514 is
// translated to a clean 400 below, same pattern as expense_category_id.
const patchMovementBodySchema = z
  .object({
    amount_cents: z.number().int().positive().optional(),
    occurred_on: occurredOnSchema.optional(),
    description: z.string().optional(),
    expense_category_id: z.number().int().positive().nullable().optional(),
    sale_item_id: z.number().int().positive().nullable().optional(),
    quantity: z.number().int().positive().nullable().optional(),
    method: z.string().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Body must include at least one field' });

const listMovementsQuerySchema = z
  .object({
    from: occurredOnSchema.optional(),
    to: occurredOnSchema.optional(),
    kind: z.enum(['income', 'expense']).optional(),
  })
  .refine((query) => !query.from || !query.to || query.to >= query.from, { message: 'to must be >= from' });

const ledgerQuerySchema = z
  .object({ from: occurredOnSchema, to: occurredOnSchema })
  .refine((query) => query.to >= query.from, { message: 'to must be >= from' });

const ledgerEntryResponseSchema = z.object({
  source: z.enum(['reservation_payment', 'cash_movement']),
  kind: z.enum(['income', 'expense']),
  date: z.string(),
  amount_cents: z.number(),
  concept: z.string(),
  method: z.string().nullable(),
  registered_by: z.number().nullable(),
  registered_by_name: z.string().nullable(),
  reservation_id: z.number().nullable(),
});

const ledgerResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  entries: z.array(ledgerEntryResponseSchema),
  totals: z.object({
    reservation_income_cents: z.number(),
    sale_income_cents: z.number(),
    expense_cents: z.number(),
    refund_cents: z.number(),
    net_cents: z.number(),
  }),
});

// § 6 (10B) — per-product report. Same querystring shape as the ledger
// (required from/to, to >= from).
const saleItemReportQuerySchema = ledgerQuerySchema;

const saleItemReportResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  items: z.array(
    z.object({
      sale_item_id: z.number(),
      name: z.string(),
      quantity_sold: z.number(),
      total_cents: z.number(),
    }),
  ),
});

// § 6 (10C) — expenses grouped by category. Same querystring shape as the
// ledger and the per-product report.
const expenseCategoryReportQuerySchema = ledgerQuerySchema;

const expenseCategoryReportResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  categories: z.array(
    z.object({
      category_id: z.number().nullable(),
      name: z.string(),
      total_cents: z.number(),
    }),
  ),
});

const errorResponseSchema = z.object({ error: z.string() });

function httpError(statusCode: number, message: string): FastifyError {
  const err = new Error(message) as FastifyError;
  err.statusCode = statusCode;
  err.code = 'PANEL_CASH_ERROR';
  err.name = 'PanelCashError';
  return err;
}

// pg's error carries the violated constraint's name in `.constraint` —
// distinguishing which CHECK fired matters now that cash_movements has
// three of them (expense_category/kind, sale_item/quantity pairing,
// sale_item/kind), where before there was only one.
const CHECK_VIOLATION_MESSAGES: Record<string, string> = {
  cash_movements_expense_category_kind_check: 'EXPENSE_CATEGORY_ID_NOT_ALLOWED_FOR_INCOME',
  cash_movements_sale_item_quantity_check: 'SALE_ITEM_ID_AND_QUANTITY_MUST_BE_PAIRED',
  cash_movements_sale_item_kind_check: 'SALE_ITEM_ID_NOT_ALLOWED_FOR_EXPENSE',
};

// Same reasoning as CHECK_VIOLATION_MESSAGES above, for FK (23503)
// violations: cash_movements has two client-controllable FKs
// (expense_category_id, sale_item_id — created_by is always server-set,
// never from the request body, so it can never violate on a caller's
// input). Found in the 10B risk-review: an unconditional 'SALE_ITEM_NOT_FOUND'
// mislabeled a bogus expense_category_id as a missing sale item.
const FK_VIOLATION_MESSAGES: Record<string, string> = {
  cash_movements_expense_category_id_fkey: 'EXPENSE_CATEGORY_NOT_FOUND',
  cash_movements_sale_item_id_fkey: 'SALE_ITEM_NOT_FOUND',
};

function rethrowAsCleanError(err: unknown): never {
  if (err && typeof err === 'object' && 'code' in err) {
    if (err.code === '23514' && 'constraint' in err && typeof err.constraint === 'string') {
      throw httpError(400, CHECK_VIOLATION_MESSAGES[err.constraint] ?? 'INVALID_MOVEMENT');
    }
    // A caller can pass an expense_category_id or sale_item_id that doesn't
    // exist (typo, stale form). Same "no raw 500 from a DB constraint" rule
    // as the CHECK violations above.
    if (err.code === '23503' && 'constraint' in err && typeof err.constraint === 'string') {
      throw httpError(400, FK_VIOLATION_MESSAGES[err.constraint] ?? 'INVALID_REFERENCE');
    }
  }
  throw err;
}

// § 7: cash.income gates income movements, cash.expense gates expense
// movements — a single role can have one without the other. The route-level
// hook only proves the requester has ONE of the two (so it isn't blocked
// outright); this decides which one the specific request actually needs.
async function assertCanWriteKind(db: Kysely<DB>, userId: number, kind: 'income' | 'expense'): Promise<void> {
  const input = await getEffectivePermissionInput(db, userId);
  const permission = kind === 'income' ? 'cash.income' : 'cash.expense';
  if (!can(input, permission)) throw httpError(403, 'FORBIDDEN');
}

export interface PanelCashPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const panelCashPlugin: FastifyPluginAsync<PanelCashPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  await fastify.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', requireAuth(db));
    protectedScope.addHook('onRequest', blockIfMustChangePassword());
    const typed = protectedScope.withTypeProvider<ZodTypeProvider>();

    // --- cash.view: expense categories (read) + the ledger ---

    await protectedScope.register(async (viewScope) => {
      viewScope.addHook('onRequest', requirePermission(db, 'cash.view'));
      const typedCategories = viewScope.withTypeProvider<ZodTypeProvider>();

      typedCategories.get(
        '/panel/cash/expense-categories',
        { schema: { response: { 200: z.array(categoryResponseSchema) } } },
        async () => {
          return db.selectFrom('cash_expense_categories').select(['id', 'name', 'active']).orderBy('name').execute();
        },
      );

      // § 3, § 5.1 — the unified read of payments + cash_movements. See
      // panel/cashLedger.ts for why this can never duplicate or drop a
      // reservation payment.
      typedCategories.get(
        '/panel/cash/ledger',
        { schema: { querystring: ledgerQuerySchema, response: { 200: ledgerResponseSchema } } },
        async (request) => {
          return getCashLedger(db, request.query);
        },
      );

      // § 6 (10B) — reading the catalog only needs cash.view (same as
      // expense categories): a cashier picking a product to sell needs
      // cash.income to write the movement, not cash.manage.
      typedCategories.get(
        '/panel/cash/sale-items',
        { schema: { response: { 200: z.array(saleItemResponseSchema) } } },
        async () => {
          return db
            .selectFrom('cash_sale_items')
            .select(['id', 'name', 'default_price_cents', 'active'])
            .orderBy('name')
            .execute();
        },
      );

      // § 6 (10B) — units sold and revenue per product in a period. See
      // panel/salesByItemReport.ts for why this sums the frozen
      // amount_cents on each sale, never default_price_cents × quantity.
      typedCategories.get(
        '/panel/cash/sale-items/report',
        { schema: { querystring: saleItemReportQuerySchema, response: { 200: saleItemReportResponseSchema } } },
        async (request) => {
          return getSalesByItemReport(db, request.query);
        },
      );

      // § 6 (10C) — expenses grouped by category in a period. See
      // panel/expensesByCategoryReport.ts for why an uncategorized expense
      // is grouped as "Sem categoria" instead of dropped (must sum to the
      // same expense_cents as the ledger's totals).
      typedCategories.get(
        '/panel/cash/expense-categories/report',
        {
          schema: {
            querystring: expenseCategoryReportQuerySchema,
            response: { 200: expenseCategoryReportResponseSchema },
          },
        },
        async (request) => {
          return getExpensesByCategoryReport(db, request.query);
        },
      );
    });

    await protectedScope.register(async (manageScope) => {
      manageScope.addHook('onRequest', requirePermission(db, 'cash.manage'));
      const typedManage = manageScope.withTypeProvider<ZodTypeProvider>();

      typedManage.post(
        '/panel/cash/expense-categories',
        {
          schema: {
            body: createCategoryBodySchema,
            response: { 201: categoryResponseSchema, 409: errorResponseSchema },
          },
        },
        async (request, reply) => {
          try {
            const row = await db
              .insertInto('cash_expense_categories')
              .values({ name: request.body.name })
              .returning(['id', 'name', 'active'])
              .executeTakeFirstOrThrow();
            reply.status(201);
            return row;
          } catch (err) {
            if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
              throw httpError(409, 'CATEGORY_NAME_ALREADY_EXISTS');
            }
            throw err;
          }
        },
      );

      typedManage.patch(
        '/panel/cash/expense-categories/:id',
        {
          schema: {
            params: z.object({ id: z.coerce.number().int().positive() }),
            body: patchCategoryBodySchema,
            response: { 200: categoryResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
          },
        },
        async (request) => {
          const { id } = request.params;
          try {
            const row = await db
              .updateTable('cash_expense_categories')
              .set(request.body)
              .where('id', '=', id)
              .returning(['id', 'name', 'active'])
              .executeTakeFirst();
            if (!row) throw httpError(404, 'CATEGORY_NOT_FOUND');
            return row;
          } catch (err) {
            if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
              throw httpError(409, 'CATEGORY_NAME_ALREADY_EXISTS');
            }
            throw err;
          }
        },
      );

      // § 6 (10B) — catalog CRUD. Same cash.manage gate as expense
      // categories: managing what's sellable is a different action from
      // selling it (cash.income, checked on POST /panel/cash/movements).
      typedManage.post(
        '/panel/cash/sale-items',
        {
          schema: {
            body: createSaleItemBodySchema,
            response: { 201: saleItemResponseSchema, 409: errorResponseSchema },
          },
        },
        async (request, reply) => {
          try {
            const row = await db
              .insertInto('cash_sale_items')
              .values({
                name: request.body.name,
                default_price_cents: request.body.default_price_cents ?? null,
              })
              .returning(['id', 'name', 'default_price_cents', 'active'])
              .executeTakeFirstOrThrow();
            reply.status(201);
            return row;
          } catch (err) {
            if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
              throw httpError(409, 'SALE_ITEM_NAME_ALREADY_EXISTS');
            }
            throw err;
          }
        },
      );

      typedManage.patch(
        '/panel/cash/sale-items/:id',
        {
          schema: {
            params: z.object({ id: z.coerce.number().int().positive() }),
            body: patchSaleItemBodySchema,
            response: { 200: saleItemResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
          },
        },
        async (request) => {
          const { id } = request.params;
          try {
            const row = await db
              .updateTable('cash_sale_items')
              .set(request.body)
              .where('id', '=', id)
              .returning(['id', 'name', 'default_price_cents', 'active'])
              .executeTakeFirst();
            if (!row) throw httpError(404, 'SALE_ITEM_NOT_FOUND');
            return row;
          } catch (err) {
            if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
              throw httpError(409, 'SALE_ITEM_NAME_ALREADY_EXISTS');
            }
            throw err;
          }
        },
      );
    });

    // --- Movements ---

    protectedScope.addHook(
      'onRequest',
      requireAnyPermission(db, ['cash.view', 'cash.income', 'cash.expense', 'cash.manage']),
    );

    typed.get(
      '/panel/cash/movements',
      {
        schema: {
          querystring: listMovementsQuerySchema,
          response: { 200: z.array(movementResponseSchema) },
        },
      },
      async (request) => {
        if (!can(await getEffectivePermissionInput(db, request.user!.id), 'cash.view')) {
          throw httpError(403, 'FORBIDDEN');
        }

        const { from, to, kind } = request.query;
        let query = db
          .selectFrom('cash_movements')
          .select([
            'id',
            'kind',
            'amount_cents',
            // Cast server-side: pg's driver parses a `date` column as
            // LOCAL-midnight, so a naive .toISOString() in a negative-offset
            // timezone (e.g. GMT-3) rolls the date back a day. Same fix
            // already established in rateOverrides.ts (`date::text`).
            sql<string>`occurred_on::text`.as('occurred_on'),
            'description',
            'expense_category_id',
            'sale_item_id',
            'quantity',
            'method',
            'created_by',
            'created_at',
          ])
          .where('deleted_at', 'is', null)
          .orderBy('occurred_on', 'desc')
          .orderBy('id', 'desc');

        if (from) query = query.where('occurred_on', '>=', sql<Date>`${from}::date`);
        if (to) query = query.where('occurred_on', '<=', sql<Date>`${to}::date`);
        if (kind) query = query.where('kind', '=', kind);

        const rows = await query.execute();
        return rows.map((row) => ({
          ...row,
          kind: row.kind as 'income' | 'expense',
          created_at: row.created_at.toISOString(),
        }));
      },
    );

    typed.post(
      '/panel/cash/movements',
      {
        schema: {
          body: createMovementBodySchema,
          response: { 201: movementResponseSchema },
        },
      },
      async (request, reply) => {
        await assertCanWriteKind(db, request.user!.id, request.body.kind);

        try {
          const row = await db
            .insertInto('cash_movements')
            .values({
              kind: request.body.kind,
              amount_cents: request.body.amount_cents,
              occurred_on: request.body.occurred_on,
              description: request.body.description ?? null,
              expense_category_id: request.body.expense_category_id ?? null,
              sale_item_id: request.body.sale_item_id ?? null,
              quantity: request.body.quantity ?? null,
              method: request.body.method ?? null,
              created_by: request.user!.id,
            })
            .returning([
              'id',
              'kind',
              'amount_cents',
              sql<string>`occurred_on::text`.as('occurred_on'),
              'description',
              'expense_category_id',
              'sale_item_id',
              'quantity',
              'method',
              'created_by',
              'created_at',
            ])
            .executeTakeFirstOrThrow();

          reply.status(201);
          return {
            ...row,
            kind: row.kind as 'income' | 'expense',
            created_at: row.created_at.toISOString(),
          };
        } catch (err) {
          rethrowAsCleanError(err);
        }
      },
    );

    typed.patch(
      '/panel/cash/movements/:id',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          body: patchMovementBodySchema,
          response: { 200: movementResponseSchema, 404: errorResponseSchema },
        },
      },
      async (request) => {
        const { id } = request.params;

        const existing = await db
          .selectFrom('cash_movements')
          .select('kind')
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!existing) throw httpError(404, 'MOVEMENT_NOT_FOUND');

        await assertCanWriteKind(db, request.user!.id, existing.kind as 'income' | 'expense');

        try {
          const row = await db
            .updateTable('cash_movements')
            .set(request.body)
            .where('id', '=', id)
            .returning([
              'id',
              'kind',
              'amount_cents',
              sql<string>`occurred_on::text`.as('occurred_on'),
              'description',
              'expense_category_id',
              'sale_item_id',
              'quantity',
              'method',
              'created_by',
              'created_at',
            ])
            .executeTakeFirstOrThrow();

          return {
            ...row,
            kind: row.kind as 'income' | 'expense',
            created_at: row.created_at.toISOString(),
          };
        } catch (err) {
          rethrowAsCleanError(err);
        }
      },
    );

    typed.delete(
      '/panel/cash/movements/:id',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          response: { 204: z.void(), 404: errorResponseSchema },
        },
      },
      async (request, reply) => {
        const { id } = request.params;

        const existing = await db
          .selectFrom('cash_movements')
          .select('kind')
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!existing) throw httpError(404, 'MOVEMENT_NOT_FOUND');

        await assertCanWriteKind(db, request.user!.id, existing.kind as 'income' | 'expense');

        await db.updateTable('cash_movements').set({ deleted_at: new Date() }).where('id', '=', id).execute();

        reply.status(204).send();
      },
    );
  });
};

export default panelCashPlugin;
