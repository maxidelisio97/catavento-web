/**
 * Integration tests for GET /panel/cash/sale-items/report —
 * SPEC-modulo-10-caja.md § 6 (entrega 10B, per-product report).
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
  await sql`TRUNCATE TABLE cash_movements, cash_sale_items, sessions, user_permission_overrides, users RESTART IDENTITY CASCADE`.execute(
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

async function insertSaleItem(name: string, defaultPriceCents: number | null = null): Promise<number> {
  const row = await testDb
    .insertInto('cash_sale_items')
    .values({ name, default_price_cents: defaultPriceCents })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertSale(input: {
  saleItemId: number | null;
  amountCents: number;
  occurredOn: string;
  quantity?: number | null;
  createdBy: number;
  description?: string;
}): Promise<number> {
  const row = await testDb
    .insertInto('cash_movements')
    .values({
      kind: 'income',
      amount_cents: input.amountCents,
      occurred_on: input.occurredOn,
      sale_item_id: input.saleItemId,
      quantity: input.saleItemId ? (input.quantity ?? 1) : null,
      description: input.description ?? null,
      created_by: input.createdBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

describe('authorization', () => {
  it('401s without a session cookie', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/panel/cash/sale-items/report?from=2026-08-01&to=2026-08-31' });
    expect(response.statusCode).toBe(401);
  });

  it('403s without cash.view', async () => {
    const roleId = await createRoleWithPermissions(testDb, ['cash.income']);
    const token = await createSessionCookieForRole(testDb, roleId);
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/sale-items/report?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /panel/cash/sale-items/report', () => {
  it('groups by product, summing quantity and the frozen amount_cents of each sale', async () => {
    const fixtureUser = await insertFixtureUser();
    const cervejaId = await insertSaleItem('Cerveja', 1000);
    const aguaId = await insertSaleItem('Água', 500);

    await insertSale({ saleItemId: cervejaId, amountCents: 1000, occurredOn: '2026-08-10', quantity: 1, createdBy: fixtureUser });
    await insertSale({ saleItemId: cervejaId, amountCents: 2000, occurredOn: '2026-08-15', quantity: 2, createdBy: fixtureUser });
    await insertSale({ saleItemId: aguaId, amountCents: 500, occurredOn: '2026-08-20', quantity: 1, createdBy: fixtureUser });

    const token = await tokenWithCashView();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/sale-items/report?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const cerveja = body.items.find((i: { sale_item_id: number }) => i.sale_item_id === cervejaId);
    const agua = body.items.find((i: { sale_item_id: number }) => i.sale_item_id === aguaId);

    expect(cerveja).toMatchObject({ name: 'Cerveja', quantity_sold: 3, total_cents: 3000 });
    expect(agua).toMatchObject({ name: 'Água', quantity_sold: 1, total_cents: 500 });
  });

  it('excludes free-concept sales (no sale_item_id) from the report', async () => {
    const fixtureUser = await insertFixtureUser();
    const cervejaId = await insertSaleItem('Cerveja', 1000);

    await insertSale({ saleItemId: cervejaId, amountCents: 1000, occurredOn: '2026-08-10', quantity: 1, createdBy: fixtureUser });
    await insertSale({ saleItemId: null, amountCents: 5000, occurredOn: '2026-08-11', createdBy: fixtureUser, description: 'Gorjeta' });

    const token = await tokenWithCashView();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/sale-items/report?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].sale_item_id).toBe(cervejaId);
  });

  it('excludes rows outside the period and soft-deleted rows', async () => {
    const fixtureUser = await insertFixtureUser();
    const cervejaId = await insertSaleItem('Cerveja', 1000);

    await insertSale({ saleItemId: cervejaId, amountCents: 1000, occurredOn: '2026-07-31', quantity: 1, createdBy: fixtureUser });
    await insertSale({ saleItemId: cervejaId, amountCents: 1000, occurredOn: '2026-09-01', quantity: 1, createdBy: fixtureUser });
    const deletedId = await insertSale({ saleItemId: cervejaId, amountCents: 1000, occurredOn: '2026-08-10', quantity: 1, createdBy: fixtureUser });
    await testDb.updateTable('cash_movements').set({ deleted_at: new Date() }).where('id', '=', deletedId).execute();

    const token = await tokenWithCashView();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/sale-items/report?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.json().items).toHaveLength(0);
  });

  it('still reports units sold with a since-deactivated sale item', async () => {
    const fixtureUser = await insertFixtureUser();
    const tourId = await insertSaleItem('Tour lancha');
    await insertSale({ saleItemId: tourId, amountCents: 5000, occurredOn: '2026-08-10', quantity: 1, createdBy: fixtureUser });
    await testDb.updateTable('cash_sale_items').set({ active: false }).where('id', '=', tourId).execute();

    const token = await tokenWithCashView();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/panel/cash/sale-items/report?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ name: 'Tour lancha', quantity_sold: 1, total_cents: 5000 });
  });

  // The central case Maxi asked to confirm with a test: proving one sale
  // row keeps its own amount_cents (already covered by the hybrid-sale
  // tests) is NOT the same as proving the report's GROUP BY...SUM never
  // recomputes from the catalog's CURRENT default_price_cents × the
  // summed quantity. Two separate sales (N=5 units total, across two
  // transactions) makes that distinction concrete: if the aggregate were
  // derived from the live catalog price instead of summing each row's
  // frozen amount_cents, changing that price would reshape the WHOLE
  // period's total, not just one row.
  it('a later catalog price change does not alter a past period\'s aggregated total (freeze applies to the SUM, not just one row)', async () => {
    const fixtureUser = await insertFixtureUser();
    const cervejaId = await insertSaleItem('Cerveja', 1000);
    // Two sales in the same period, at the price that was current when
    // each happened — 2 units @ 1000/unit, then 3 units @ 1000/unit.
    await insertSale({ saleItemId: cervejaId, amountCents: 2000, occurredOn: '2026-08-10', quantity: 2, createdBy: fixtureUser });
    await insertSale({ saleItemId: cervejaId, amountCents: 3000, occurredOn: '2026-08-20', quantity: 3, createdBy: fixtureUser });

    const token = await tokenWithCashView();
    const app = buildApp();

    const before = await app.inject({
      method: 'GET',
      url: '/panel/cash/sale-items/report?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(before.json().items[0]).toMatchObject({ quantity_sold: 5, total_cents: 5000 });

    // Catalog price jumps from 1000 to 9999/unit. If the report's SUM were
    // derived from default_price_cents × quantity_sold instead of summing
    // each row's frozen amount_cents, the period's total would now read
    // 5 × 9999 = 49995, not 5000.
    await testDb.updateTable('cash_sale_items').set({ default_price_cents: 9999 }).where('id', '=', cervejaId).execute();

    const after = await app.inject({
      method: 'GET',
      url: '/panel/cash/sale-items/report?from=2026-08-01&to=2026-08-31',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(after.json().items[0]).toMatchObject({ quantity_sold: 5, total_cents: 5000 });
  });
});
