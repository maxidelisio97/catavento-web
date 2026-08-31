/**
 * GET/POST /panel/cash/expense-categories, PATCH .../:id,
 * GET/POST/PATCH/DELETE /panel/cash/movements —
 * SPEC-modulo-10-caja.md § 5.1 (entrega 10A, libro base).
 *
 * Does NOT include GET /panel/cash/ledger (§ 3, the unified read of
 * `payments` + `cash_movements`) — that lands in the next batch of 10A,
 * separately from this CRUD layer.
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

const movementResponseSchema = z.object({
  id: z.number(),
  kind: z.enum(['income', 'expense']),
  amount_cents: z.number(),
  occurred_on: z.string(),
  description: z.string().nullable(),
  expense_category_id: z.number().nullable(),
  method: z.string().nullable(),
  created_by: z.number(),
  created_at: z.string(),
});

// § 5.2: an expense's form has a category select; a manual income has none
// (no sale_item_id/catalog until 10B) — so the presence of
// expense_category_id is tied to kind, not left to caller judgment.
const createMovementBodySchema = z
  .object({
    kind: z.enum(['income', 'expense']),
    amount_cents: z.number().int().positive(),
    occurred_on: occurredOnSchema,
    description: z.string().optional(),
    expense_category_id: z.number().int().positive().optional(),
    method: z.string().optional(),
  })
  .refine((body) => body.kind === 'expense' || body.expense_category_id === undefined, {
    message: 'expense_category_id is only valid for kind=expense',
  })
  .refine((body) => body.kind === 'income' || body.expense_category_id !== undefined, {
    message: 'expense_category_id is required for kind=expense',
  });

// Editing a movement's kind is out of scope — a mis-entered movement is
// soft-deleted and re-created, not flipped from income to expense in place.
const patchMovementBodySchema = z
  .object({
    amount_cents: z.number().int().positive().optional(),
    occurred_on: occurredOnSchema.optional(),
    description: z.string().optional(),
    expense_category_id: z.number().int().positive().nullable().optional(),
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

const errorResponseSchema = z.object({ error: z.string() });

function httpError(statusCode: number, message: string): FastifyError {
  const err = new Error(message) as FastifyError;
  err.statusCode = statusCode;
  err.code = 'PANEL_CASH_ERROR';
  err.name = 'PanelCashError';
  return err;
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

        const row = await db
          .insertInto('cash_movements')
          .values({
            kind: request.body.kind,
            amount_cents: request.body.amount_cents,
            occurred_on: request.body.occurred_on,
            description: request.body.description ?? null,
            expense_category_id: request.body.expense_category_id ?? null,
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
          // cash_movements_expense_category_kind_check: an income row can't
          // carry expense_category_id — same "don't let a raw DB constraint
          // surface as a 500" rule as the 23505 handling above.
          if (err && typeof err === 'object' && 'code' in err && err.code === '23514') {
            throw httpError(400, 'EXPENSE_CATEGORY_ID_NOT_ALLOWED_FOR_INCOME');
          }
          throw err;
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
