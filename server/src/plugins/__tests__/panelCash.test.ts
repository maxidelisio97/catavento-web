/**
 * Integration tests for SPEC-modulo-10-caja.md § 5.1 (entrega 10A) —
 * GET/POST /panel/cash/expense-categories, PATCH .../:id,
 * GET/POST/PATCH/DELETE /panel/cash/movements — and § 6 (entrega 10B) —
 * GET/POST/PATCH /panel/cash/sale-items (catalog CRUD only in this batch;
 * the hybrid sale on POST /panel/cash/movements and the per-product report
 * arrive in later 10B batches, per plan).
 *
 * Does NOT cover GET /panel/cash/ledger — that arrives with the next batch
 * of 10A and gets its own test file (the "no duplicate payments" test is
 * the central case there, per plan).
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import cookiePlugin from '@fastify/cookie';
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../db/testClient.js';
import { registerErrorHandler } from '../../errorHandler.js';
import panelCashPlugin from '../panelCash.js';
import { createRoleWithPermissions, createSessionCookieForRole } from '../../test-support/permissionFixtures.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';

function buildApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookiePlugin);
  app.register(panelCashPlugin, { db: testDb });
  registerErrorHandler(app);
  return app;
}

// Deliberately does NOT truncate roles/permissions — same reasoning as
// requirePermission.test.ts / panelUsers.test.ts: the M9 seed + this
// migration's cash.* seed must survive across test files sharing the DB.
async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE cash_movements, cash_expense_categories, cash_sale_items, sessions, user_permission_overrides, users RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

beforeEach(resetDb);

async function tokenWith(permissions: string[]): Promise<string> {
  const roleId = await createRoleWithPermissions(testDb, permissions);
  return createSessionCookieForRole(testDb, roleId);
}

async function insertCategory(name = 'Fornecedores'): Promise<number> {
  const row = await testDb
    .insertInto('cash_expense_categories')
    .values({ name })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertSaleItem(overrides: { name?: string; default_price_cents?: number | null } = {}): Promise<number> {
  const row = await testDb
    .insertInto('cash_sale_items')
    .values({ name: overrides.name ?? 'Cerveja', default_price_cents: overrides.default_price_cents ?? 1000 })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

describe('authorization', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/panel/cash/movements' });
    expect(response.statusCode).toBe(401);
  });

  it('403s GET /panel/cash/movements without cash.view/income/expense', async () => {
    const token = await tokenWith([]);
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/movements',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(403);
  });

  it('403s GET /panel/cash/expense-categories without cash.view', async () => {
    const token = await tokenWith(['cash.income']);
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/expense-categories',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(403);
  });

  it('403s POST /panel/cash/expense-categories with only cash.view', async () => {
    const token = await tokenWith(['cash.view']);
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/panel/cash/expense-categories',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Sueldos' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('creates a category with only cash.manage (no cash.view needed)', async () => {
    const token = await tokenWith(['cash.manage']);
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/panel/cash/expense-categories',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Sueldos' },
    });
    expect(response.statusCode).toBe(201);
  });

  it('403s POST /panel/cash/expense-categories without any cash permission', async () => {
    const token = await tokenWith([]);
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/panel/cash/expense-categories',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Sueldos' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('expense categories', () => {
  it('creates and lists a category', async () => {
    const token = await tokenWith(['cash.view', 'cash.manage']);
    const app = buildApp();

    const create = await app.inject({
      method: 'POST',
      url: '/panel/cash/expense-categories',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Manutenção' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toEqual({ id: expect.any(Number), name: 'Manutenção', active: true });

    const list = await app.inject({
      method: 'GET',
      url: '/panel/cash/expense-categories',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(list.json()).toEqual([{ id: expect.any(Number), name: 'Manutenção', active: true }]);
  });

  it('409s on a duplicate category name', async () => {
    const token = await tokenWith(['cash.view', 'cash.manage']);
    const app = buildApp();
    await insertCategory('Serviços');

    const response = await app.inject({
      method: 'POST',
      url: '/panel/cash/expense-categories',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Serviços' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('renames and deactivates a category via PATCH', async () => {
    const token = await tokenWith(['cash.view', 'cash.manage']);
    const app = buildApp();
    const id = await insertCategory('Provisória');

    const response = await app.inject({
      method: 'PATCH',
      url: `/panel/cash/expense-categories/${id}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Proveedores', active: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id, name: 'Proveedores', active: false });
  });

  it('404s PATCH on a nonexistent category', async () => {
    const token = await tokenWith(['cash.view', 'cash.manage']);
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/cash/expense-categories/999999',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { active: false },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('sale items catalog', () => {
  it('creates and lists a sale item', async () => {
    const token = await tokenWith(['cash.view', 'cash.manage']);
    const app = buildApp();

    const create = await app.inject({
      method: 'POST',
      url: '/panel/cash/sale-items',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Água', default_price_cents: 500 },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toEqual({ id: expect.any(Number), name: 'Água', default_price_cents: 500, active: true });

    const list = await app.inject({
      method: 'GET',
      url: '/panel/cash/sale-items',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(list.json()).toEqual([{ id: expect.any(Number), name: 'Água', default_price_cents: 500, active: true }]);
  });

  it('creates a sale item with no suggested price (nullable)', async () => {
    const token = await tokenWith(['cash.manage']);
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/cash/sale-items',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Tour lancha' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().default_price_cents).toBeNull();
  });

  it('409s on a duplicate sale item name', async () => {
    const token = await tokenWith(['cash.manage']);
    const app = buildApp();
    await insertSaleItem({ name: 'Cerveja' });

    const response = await app.inject({
      method: 'POST',
      url: '/panel/cash/sale-items',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Cerveja' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('renames, reprices, and deactivates a sale item via PATCH', async () => {
    const token = await tokenWith(['cash.manage']);
    const app = buildApp();
    const id = await insertSaleItem({ name: 'Cerveja', default_price_cents: 1000 });

    const response = await app.inject({
      method: 'PATCH',
      url: `/panel/cash/sale-items/${id}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Cerveja gelada', default_price_cents: 1200, active: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id, name: 'Cerveja gelada', default_price_cents: 1200, active: false });
  });

  it('404s PATCH on a nonexistent sale item', async () => {
    const token = await tokenWith(['cash.manage']);
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/panel/cash/sale-items/999999',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { active: false },
    });
    expect(response.statusCode).toBe(404);
  });

  it('403s GET /panel/cash/sale-items without cash.view', async () => {
    const token = await tokenWith(['cash.income']);
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/sale-items',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(403);
  });

  it('403s POST /panel/cash/sale-items with only cash.view (deactivating the catalog needs cash.manage)', async () => {
    const token = await tokenWith(['cash.view']);
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/panel/cash/sale-items',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Refrigerante' },
    });
    expect(response.statusCode).toBe(403);
  });

  // The bug the 10A risk-review found: a parent-scope permission hook that
  // doesn't list every nested route's permission bounces a valid caller
  // before the route-level check even runs. This proves the fix still
  // covers 10B's new routes without editing the parent hook — cash.manage
  // was already in that list from 10A, so a manage-only caller must never
  // 403 at the door before reaching a route it's actually allowed to use.
  it('does not reintroduce the 10A parent-scope permission gap for the new catalog routes', async () => {
    const token = await tokenWith(['cash.manage']);
    const app = buildApp();

    const create = await app.inject({
      method: 'POST',
      url: '/panel/cash/sale-items',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { name: 'Suco' },
    });
    expect(create.statusCode).toBe(201);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/panel/cash/sale-items/${create.json().id}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { active: false },
    });
    expect(patch.statusCode).toBe(200);
  });
});

describe('POST /panel/cash/movements', () => {
  it('403s registering income without cash.income', async () => {
    const token = await tokenWith(['cash.view', 'cash.expense']);
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/cash/movements',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'income', amount_cents: 1500, occurred_on: '2026-08-30', description: 'Cerveja avulsa' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('403s registering an expense without cash.expense', async () => {
    const categoryId = await insertCategory();
    const token = await tokenWith(['cash.view', 'cash.income']);
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/cash/movements',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'expense', amount_cents: 5000, occurred_on: '2026-08-30', expense_category_id: categoryId },
    });
    expect(response.statusCode).toBe(403);
  });

  it('registers a manual income and stamps created_by from the session, never the client', async () => {
    const roleId = await createRoleWithPermissions(testDb, ['cash.income']);
    const token = await createSessionCookieForRole(testDb, roleId);
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/cash/movements',
      cookies: { [SESSION_COOKIE_NAME]: token },
      // created_by in the payload must be ignored — it isn't in the schema,
      // and even if it were, the handler always uses request.user.id.
      payload: {
        kind: 'income',
        amount_cents: 1500,
        occurred_on: '2026-08-30',
        description: 'Cerveja avulsa',
        created_by: 999999,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.kind).toBe('income');
    expect(body.amount_cents).toBe(1500);
    expect(body.occurred_on).toBe('2026-08-30');
    expect(body.expense_category_id).toBeNull();
    expect(body.created_by).not.toBe(999999);

    // resetDb truncates users every test, so the role/session fixture above
    // is the only user in the table — this is that same user's real id.
    const sessionUser = await testDb.selectFrom('users').select('id').executeTakeFirstOrThrow();
    expect(body.created_by).toBe(sessionUser.id);
  });

  it('registers an expense with a category', async () => {
    const categoryId = await insertCategory();
    const token = await tokenWith(['cash.expense']);
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/cash/movements',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: {
        kind: 'expense',
        amount_cents: 12000,
        occurred_on: '2026-08-30',
        expense_category_id: categoryId,
        method: 'cash',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ kind: 'expense', amount_cents: 12000, expense_category_id: categoryId });
  });

  it('400s an expense with no expense_category_id', async () => {
    const token = await tokenWith(['cash.expense']);
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/cash/movements',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'expense', amount_cents: 12000, occurred_on: '2026-08-30' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('400s an income that carries an expense_category_id', async () => {
    const categoryId = await insertCategory();
    const token = await tokenWith(['cash.income']);
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/cash/movements',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'income', amount_cents: 1000, occurred_on: '2026-08-30', expense_category_id: categoryId },
    });
    expect(response.statusCode).toBe(400);
  });

  it('400s amount_cents <= 0', async () => {
    const token = await tokenWith(['cash.income']);
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/cash/movements',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'income', amount_cents: 0, occurred_on: '2026-08-30' },
    });
    expect(response.statusCode).toBe(400);
  });

  // The exact bug documented in server/CLAUDE.md ("deuda de dateSchema"):
  // a regex-only date schema lets 2026-13-45 through and it blows up as a
  // raw 500 at the ::date cast. This must come back as a clean 400.
  it('400s an invalid calendar date instead of 500ing', async () => {
    const token = await tokenWith(['cash.income']);
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/panel/cash/movements',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'income', amount_cents: 1000, occurred_on: '2026-13-45' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /panel/cash/movements', () => {
  async function insertMovement(overrides: Partial<{ kind: 'income' | 'expense'; occurred_on: string; amount_cents: number; deleted_at: Date }> = {}) {
    const userId = (
      await testDb
        .insertInto('users')
        .values({
          email: `${crypto.randomUUID()}@catavento.test`,
          name: 'Fixture',
          password_hash: 'x',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

    return testDb
      .insertInto('cash_movements')
      .values({
        kind: overrides.kind ?? 'income',
        amount_cents: overrides.amount_cents ?? 1000,
        occurred_on: overrides.occurred_on ?? '2026-08-30',
        created_by: userId,
        deleted_at: overrides.deleted_at ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  it('filters by from/to and kind, and excludes soft-deleted rows', async () => {
    await insertMovement({ kind: 'income', occurred_on: '2026-08-01' });
    await insertMovement({ kind: 'expense', occurred_on: '2026-08-15' });
    await insertMovement({ kind: 'income', occurred_on: '2026-09-01' });
    await insertMovement({ kind: 'income', occurred_on: '2026-08-20', deleted_at: new Date() });

    const token = await tokenWith(['cash.view']);
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/movements?from=2026-08-01&to=2026-08-31&kind=income',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    const rows = response.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].occurred_on).toBe('2026-08-01');
  });
});

describe('PATCH and DELETE /panel/cash/movements/:id', () => {
  it('edits a movement, requiring the permission matching its existing kind', async () => {
    const categoryId = await insertCategory();
    const expenseToken = await tokenWith(['cash.expense']);
    const app = buildApp();

    const create = await app.inject({
      method: 'POST',
      url: '/panel/cash/movements',
      cookies: { [SESSION_COOKIE_NAME]: expenseToken },
      payload: { kind: 'expense', amount_cents: 5000, occurred_on: '2026-08-30', expense_category_id: categoryId },
    });
    const id = create.json().id;

    const wrongPermToken = await tokenWith(['cash.income']);
    const forbidden = await app.inject({
      method: 'PATCH',
      url: `/panel/cash/movements/${id}`,
      cookies: { [SESSION_COOKIE_NAME]: wrongPermToken },
      payload: { amount_cents: 6000 },
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'PATCH',
      url: `/panel/cash/movements/${id}`,
      cookies: { [SESSION_COOKIE_NAME]: expenseToken },
      payload: { amount_cents: 6000, description: 'Corrigido' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().amount_cents).toBe(6000);
  });

  it('soft-deletes a movement: 204, then it disappears from the list and further writes 404', async () => {
    const token = await tokenWith(['cash.view', 'cash.income']);
    const app = buildApp();

    const create = await app.inject({
      method: 'POST',
      url: '/panel/cash/movements',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'income', amount_cents: 1000, occurred_on: '2026-08-30' },
    });
    const id = create.json().id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/panel/cash/movements/${id}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET',
      url: '/panel/cash/movements',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(list.json()).toEqual([]);

    const patchAfterDelete = await app.inject({
      method: 'PATCH',
      url: `/panel/cash/movements/${id}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { amount_cents: 2000 },
    });
    expect(patchAfterDelete.statusCode).toBe(404);

    const row = await testDb.selectFrom('cash_movements').select(['deleted_at']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
  });

  it('400s PATCHing an expense_category_id onto an income movement (DB constraint, not a raw 500)', async () => {
    const categoryId = await insertCategory();
    const token = await tokenWith(['cash.income']);
    const app = buildApp();

    const create = await app.inject({
      method: 'POST',
      url: '/panel/cash/movements',
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { kind: 'income', amount_cents: 1000, occurred_on: '2026-08-30' },
    });
    const id = create.json().id;

    const response = await app.inject({
      method: 'PATCH',
      url: `/panel/cash/movements/${id}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { expense_category_id: categoryId },
    });
    expect(response.statusCode).toBe(400);
  });

  it('404s DELETE on a nonexistent movement', async () => {
    const token = await tokenWith(['cash.income']);
    const app = buildApp();

    const response = await app.inject({
      method: 'DELETE',
      url: '/panel/cash/movements/999999',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(404);
  });
});
