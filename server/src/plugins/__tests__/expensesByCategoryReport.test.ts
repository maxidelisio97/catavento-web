/**
 * Integration tests for GET /panel/cash/expense-categories/report —
 * SPEC-modulo-10-caja.md § 6 (entrega 10C, expenses-by-category report).
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

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE cash_movements, cash_expense_categories, sessions, user_permission_overrides, users RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

beforeEach(resetDb);

async function tokenWithCashView(): Promise<string> {
  const roleId = await createRoleWithPermissions(testDb, ['cash.view']);
  return createSessionCookieForRole(testDb, roleId);
}

async function insertFixtureUser(): Promise<number> {
  const row = await testDb
    .insertInto('users')
    .values({ email: `${crypto.randomUUID()}@catavento.test`, name: 'Fixture', password_hash: 'x' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertCategory(name: string): Promise<number> {
  const row = await testDb
    .insertInto('cash_expense_categories')
    .values({ name })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertExpense(input: {
  amountCents: number;
  occurredOn: string;
  createdBy: number;
  expenseCategoryId?: number | null;
}): Promise<number> {
  const row = await testDb
    .insertInto('cash_movements')
    .values({
      kind: 'expense',
      amount_cents: input.amountCents,
      occurred_on: input.occurredOn,
      created_by: input.createdBy,
      expense_category_id: input.expenseCategoryId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

describe('authorization', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/expense-categories/report?from=2026-08-01&to=2026-08-31',
    });
    expect(response.statusCode).toBe(401);
  });

  it('403s without cash.view', async () => {
    const roleId = await createRoleWithPermissions(testDb, ['cash.income']);
    const token = await createSessionCookieForRole(testDb, roleId);
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/expense-categories/report?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /panel/cash/expense-categories/report', () => {
  it('groups expenses by category, summing amount_cents', async () => {
    const fixtureUser = await insertFixtureUser();
    const suppliersId = await insertCategory('Fornecedores');
    const salariesId = await insertCategory('Salários');

    await insertExpense({ amountCents: 5000, occurredOn: '2026-08-10', createdBy: fixtureUser, expenseCategoryId: suppliersId });
    await insertExpense({ amountCents: 3000, occurredOn: '2026-08-15', createdBy: fixtureUser, expenseCategoryId: suppliersId });
    await insertExpense({ amountCents: 20000, occurredOn: '2026-08-05', createdBy: fixtureUser, expenseCategoryId: salariesId });

    const token = await tokenWithCashView();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/expense-categories/report?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const suppliers = body.categories.find((c: { category_id: number }) => c.category_id === suppliersId);
    const salaries = body.categories.find((c: { category_id: number }) => c.category_id === salariesId);

    expect(suppliers).toMatchObject({ name: 'Fornecedores', total_cents: 8000 });
    expect(salaries).toMatchObject({ name: 'Salários', total_cents: 20000 });
  });

  // The detail Maxi flagged: an uncategorized expense is still money that
  // left the register. Dropping it here (an INNER JOIN would) makes this
  // report undercount relative to the ledger's expense_cents.
  it('groups expenses with no category under "Sem categoria" instead of dropping them', async () => {
    const fixtureUser = await insertFixtureUser();
    await insertExpense({ amountCents: 1500, occurredOn: '2026-08-10', createdBy: fixtureUser, expenseCategoryId: null });

    const token = await tokenWithCashView();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/expense-categories/report?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const body = response.json();
    expect(body.categories).toHaveLength(1);
    expect(body.categories[0]).toMatchObject({ category_id: null, name: 'Sem categoria', total_cents: 1500 });
  });

  it('excludes income movements, rows outside the period, and soft-deleted rows', async () => {
    const fixtureUser = await insertFixtureUser();
    const categoryId = await insertCategory('Manutenção');

    await testDb
      .insertInto('cash_movements')
      .values({
        kind: 'income',
        amount_cents: 9999,
        occurred_on: '2026-08-10',
        created_by: fixtureUser,
      })
      .execute();
    await insertExpense({ amountCents: 1000, occurredOn: '2026-07-31', createdBy: fixtureUser, expenseCategoryId: categoryId });
    await insertExpense({ amountCents: 1000, occurredOn: '2026-09-01', createdBy: fixtureUser, expenseCategoryId: categoryId });
    const deletedId = await insertExpense({
      amountCents: 1000,
      occurredOn: '2026-08-10',
      createdBy: fixtureUser,
      expenseCategoryId: categoryId,
    });
    await testDb.updateTable('cash_movements').set({ deleted_at: new Date() }).where('id', '=', deletedId).execute();

    const token = await tokenWithCashView();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/expense-categories/report?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.json().categories).toHaveLength(0);
  });

  it('still reports past expenses under a since-deactivated category', async () => {
    const fixtureUser = await insertFixtureUser();
    const categoryId = await insertCategory('Extinta');
    await insertExpense({ amountCents: 2500, occurredOn: '2026-08-10', createdBy: fixtureUser, expenseCategoryId: categoryId });
    await testDb.updateTable('cash_expense_categories').set({ active: false }).where('id', '=', categoryId).execute();

    const token = await tokenWithCashView();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/expense-categories/report?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const body = response.json();
    expect(body.categories).toHaveLength(1);
    expect(body.categories[0]).toMatchObject({ name: 'Extinta', total_cents: 2500 });
  });

  // The consistency test Maxi asked for: this report's grand total (across
  // every category, including "Sem categoria") must equal the ledger's
  // expense_cents for the exact same period. If they diverge, one report is
  // silently counting expenses the other is dropping or double-counting.
  it("this report's grand total matches the ledger's expense_cents for the same period", async () => {
    const fixtureUser = await insertFixtureUser();
    const categoryId = await insertCategory('Fornecedores');

    await insertExpense({ amountCents: 4000, occurredOn: '2026-08-10', createdBy: fixtureUser, expenseCategoryId: categoryId });
    await insertExpense({ amountCents: 1200, occurredOn: '2026-08-20', createdBy: fixtureUser, expenseCategoryId: null });
    // Outside the period and soft-deleted rows must be excluded from BOTH
    // reports identically — otherwise this test could pass by coincidence.
    await insertExpense({ amountCents: 9000, occurredOn: '2026-09-05', createdBy: fixtureUser, expenseCategoryId: categoryId });
    const deletedId = await insertExpense({
      amountCents: 500,
      occurredOn: '2026-08-11',
      createdBy: fixtureUser,
      expenseCategoryId: categoryId,
    });
    await testDb.updateTable('cash_movements').set({ deleted_at: new Date() }).where('id', '=', deletedId).execute();

    const token = await tokenWithCashView();
    const app = buildApp();

    const [categoryReportResponse, ledgerResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/panel/cash/expense-categories/report?from=2026-08-01&to=2026-08-31',
        cookies: { [SESSION_COOKIE_NAME]: token },
      }),
      app.inject({
        method: 'GET',
        url: '/panel/cash/ledger?from=2026-08-01&to=2026-08-31',
        cookies: { [SESSION_COOKIE_NAME]: token },
      }),
    ]);

    const categoryReportTotal = categoryReportResponse
      .json()
      .categories.reduce((sum: number, c: { total_cents: number }) => sum + c.total_cents, 0);
    const ledgerExpenseCents = ledgerResponse.json().totals.expense_cents;

    expect(categoryReportTotal).toBe(4000 + 1200);
    expect(categoryReportTotal).toBe(ledgerExpenseCents);
  });
});
