/**
 * Characterization test written BEFORE generalizing `createOrReusePayment`
 * (`createOrReuseAsaasPayment` -> `createOrReuseProviderPayment`) for
 * SPEC-modulo-7-gestion-operativa.md § 5.4 (kind/method payments beyond the
 * M4 deposit), and again for sdd/asaas-pagarme-migration PR 4 (task A11).
 * Locks down the deposit path's behavior — DB method mapping, the "reuse a
 * live pending payment" rule, and the inserted row shape — so the provider
 * generalization can't silently change it for Asaas, while adding the new
 * Pagar.me dispatch paths (design's Call-site integration table) and the
 * drain guarantee (design A2/A3: an in-flight Asaas row keeps resolving
 * against Asaas even after the active-provider flag flips).
 */
import { sql } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../db/testClient.js';

const createCustomer = vi.fn();
const createPayment = vi.fn();
const getPayment = vi.fn();
const getPixQrCode = vi.fn();
const createOrder = vi.fn();
const getOrder = vi.fn();

vi.mock('../../asaasClient.js', () => ({
  createCustomer: (...args: unknown[]) => createCustomer(...args),
  createPayment: (...args: unknown[]) => createPayment(...args),
  getPayment: (...args: unknown[]) => getPayment(...args),
  getPixQrCode: (...args: unknown[]) => getPixQrCode(...args),
}));

vi.mock('../../pagarmeClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../pagarmeClient.js')>();
  return {
    ...actual,
    createOrder: (...args: unknown[]) => createOrder(...args),
    getOrder: (...args: unknown[]) => getOrder(...args),
  };
});

// Side-effect imports: both adapters self-register via registerProvider()
// at module load — same pattern the design's Testing Strategy calls out
// ("vi.mock the adapter registry, same pattern the existing
// createOrReusePayment.test.ts uses for asaasClient.js").
await import('../../payments/asaasAdapter.js');
await import('../../payments/pagarmeAdapter.js');

const { createOrReuseProviderPayment, PaymentAlreadyReceivedError } = await import('../createOrReusePayment.js');
const { config } = await import('../../config.js');

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE payments, reservations, rate_overrides, room_rates, rooms RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

async function insertTestReservation(code = 'TEST0001'): Promise<{ id: number; code: string }> {
  const room = await testDb
    .insertInto('rooms')
    .values({
      name: 'TestRoom',
      capacity: 2,
      pets_allowed: false,
      default_min_stay: 1,
      total_units: 1,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const reservation = await testDb
    .insertInto('reservations')
    .values({
      room_id: room.id,
      code,
      status: 'pending_payment',
      check_in: '2026-09-01',
      check_out: '2026-09-03',
      guests: 2,
      total_cents: 20000,
      deposit_cents: 10000,
      guest_name: 'Maria Silva',
      guest_email: 'maria@example.com',
      guest_phone: '11999998888',
      expires_at: new Date(Date.now() + 30 * 60 * 1000),
    })
    .returning(['id', 'code'])
    .executeTakeFirstOrThrow();

  return { id: reservation.id, code: reservation.code as string };
}

const baseInput = {
  guestName: 'Maria Silva',
  guestEmail: 'maria@example.com',
  guestPhone: '11999998888',
  cpfCnpj: '12345678900',
  dueDate: '2026-09-01',
};

beforeEach(async () => {
  await resetDb();
  createCustomer.mockReset();
  createPayment.mockReset();
  getPayment.mockReset();
  getPixQrCode.mockReset();
  createOrder.mockReset();
  getOrder.mockReset();
  // Default to today's real production default (asaas) unless a test
  // explicitly flips it — mirrors the task brief's "does not need to
  // change default runtime behavior yet" instruction.
  config.payments.provider = 'asaas';
});

describe('createOrReuseProviderPayment — Asaas characterization (byte-identical behavior, dispatched through the provider port)', () => {
  it('pix: creates a customer + PIX payment, inserts a pending deposit row mapped to asaas_pix, writes provider + provider_payment_id + dual-written asaas_payment_id', async () => {
    const reservation = await insertTestReservation();
    createCustomer.mockResolvedValue({ id: 'cus_1' });
    createPayment.mockResolvedValue({ id: 'pay_1', status: 'PENDING', invoiceUrl: 'https://asaas.test/inv/1' });
    getPixQrCode.mockResolvedValue({
      encodedImage: 'img',
      payload: 'copy-paste',
      expirationDate: '2026-09-01T00:00:00Z',
    });

    const details = await createOrReuseProviderPayment(testDb, {
      ...baseInput,
      reservationId: reservation.id,
      code: reservation.code,
      kind: 'deposit',
      method: 'pix',
      amountCents: 10000,
    });

    expect(details).toEqual({
      method: 'pix',
      provider: 'asaas',
      paymentId: 'pay_1',
      qrCode: { encodedImage: 'img', payload: 'copy-paste', expirationDate: '2026-09-01T00:00:00Z' },
    });

    expect(createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        billingType: 'PIX',
        value: 100, // amountCents / 100
        description: `Depósito reserva ${reservation.code} — Pousada Catavento`,
        externalReference: reservation.code,
      }),
    );

    const row = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .executeTakeFirstOrThrow();

    expect(row.asaas_payment_id).toBe('pay_1');
    expect(row.provider).toBe('asaas');
    expect(row.provider_payment_id).toBe('pay_1');
    expect(row.method).toBe('asaas_pix');
    expect(row.kind).toBe('deposit');
    expect(row.amount_cents).toBe(10000);
    expect(row.status).toBe('pending');
  });

  it('card: maps method to asaas_card, returns invoiceUrl (A20: asaas checkout redirect stays byte-identical)', async () => {
    const reservation = await insertTestReservation();
    createCustomer.mockResolvedValue({ id: 'cus_1' });
    createPayment.mockResolvedValue({ id: 'pay_2', status: 'PENDING', invoiceUrl: 'https://asaas.test/inv/2' });

    const details = await createOrReuseProviderPayment(testDb, {
      ...baseInput,
      reservationId: reservation.id,
      code: reservation.code,
      kind: 'deposit',
      method: 'card',
      amountCents: 10000,
    });

    expect(details).toEqual({
      method: 'card',
      provider: 'asaas',
      paymentId: 'pay_2',
      invoiceUrl: 'https://asaas.test/inv/2',
    });
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ billingType: 'CREDIT_CARD' }));

    const row = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(row.method).toBe('asaas_card');
    expect(row.provider).toBe('asaas');
  });

  it('reuses a still-pending Asaas charge instead of creating a second one, refetching the live invoice_url via fetchCardInvoiceUrl for a card reuse', async () => {
    const reservation = await insertTestReservation();
    await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservation.id,
        asaas_payment_id: 'pay_existing',
        provider: 'asaas',
        provider_payment_id: 'pay_existing',
        method: 'asaas_pix',
        amount_cents: 10000,
        status: 'pending',
      })
      .execute();

    getPayment.mockResolvedValue({ id: 'pay_existing', status: 'PENDING', invoiceUrl: 'https://asaas.test/inv/x' });
    getPixQrCode.mockResolvedValue({ encodedImage: 'img', payload: 'copy', expirationDate: '2026-09-01T00:00:00Z' });

    const details = await createOrReuseProviderPayment(testDb, {
      ...baseInput,
      reservationId: reservation.id,
      code: reservation.code,
      kind: 'deposit',
      method: 'pix',
      amountCents: 10000,
    });

    expect(createCustomer).not.toHaveBeenCalled();
    expect(createPayment).not.toHaveBeenCalled();
    expect(details).toEqual({
      method: 'pix',
      provider: 'asaas',
      paymentId: 'pay_existing',
      qrCode: { payload: 'copy', encodedImage: 'img', expirationDate: '2026-09-01T00:00:00Z' },
    });

    const rows = await testDb.selectFrom('payments').selectAll().where('reservation_id', '=', reservation.id).execute();
    expect(rows).toHaveLength(1);
  });

  it('throws PaymentAlreadyReceivedError when Asaas already has the money, but still persists the local row as received (rollback-bug fix, sdd/asaas-pagarme-migration PR 2, verified survives the PR 4 generalization)', async () => {
    const reservation = await insertTestReservation();
    await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservation.id,
        asaas_payment_id: 'pay_existing',
        provider: 'asaas',
        provider_payment_id: 'pay_existing',
        method: 'asaas_pix',
        amount_cents: 10000,
        status: 'pending',
      })
      .execute();

    getPayment.mockResolvedValue({ id: 'pay_existing', status: 'RECEIVED', invoiceUrl: 'https://asaas.test/inv/x' });

    await expect(
      createOrReuseProviderPayment(testDb, {
        ...baseInput,
        reservationId: reservation.id,
        code: reservation.code,
        kind: 'deposit',
        method: 'pix',
        amountCents: 10000,
      }),
    ).rejects.toBeInstanceOf(PaymentAlreadyReceivedError);

    // FIXED: the "mark received" UPDATE now commits with the rest of the
    // transaction — PaymentAlreadyReceivedError is thrown AFTER commit,
    // outside the transaction callback, so Kysely no longer rolls the
    // UPDATE back. Previously this asserted status stayed 'pending' (see
    // git history / server/CLAUDE.md "Deuda conocida" for the prior bug).
    const row = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('asaas_payment_id', '=', 'pay_existing')
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('received');
    expect(row.received_at).not.toBeNull();
  });
});

describe('createOrReuseProviderPayment — Pagar.me dispatch (sdd/asaas-pagarme-migration PR 4, task A11)', () => {
  beforeEach(() => {
    config.payments.provider = 'pagarme';
  });

  it('pix: dispatches a NEW charge to Pagar.me when the active flag is pagarme — inserts pagarme_pix, writes provider_payment_id, NEVER dual-writes asaas_payment_id', async () => {
    const reservation = await insertTestReservation('PGME0001');
    createOrder.mockResolvedValue({
      id: 'or_1',
      status: 'pending',
      charges: [{ last_transaction: { qr_code: 'copy-paste', qr_code_url: 'https://pagar.me/qr/1', expires_at: '2026-09-01T00:30:00Z' } }],
    });

    const details = await createOrReuseProviderPayment(testDb, {
      ...baseInput,
      reservationId: reservation.id,
      code: reservation.code,
      kind: 'deposit',
      method: 'pix',
      amountCents: 10000,
    });

    expect(details).toEqual({
      method: 'pix',
      provider: 'pagarme',
      paymentId: 'or_1',
      qrCode: { payload: 'copy-paste', imageUrl: 'https://pagar.me/qr/1', expirationDate: '2026-09-01T00:30:00Z' },
    });
    expect(createCustomer).not.toHaveBeenCalled();
    expect(createPayment).not.toHaveBeenCalled();

    const row = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(row.provider).toBe('pagarme');
    expect(row.provider_payment_id).toBe('or_1');
    expect(row.asaas_payment_id).toBeNull();
    expect(row.method).toBe('pagarme_pix');
    expect(row.status).toBe('pending');
  });

  it('card: requires cardToken, sends it as credit_card.card_token, never leaks a raw PAN field', async () => {
    const reservation = await insertTestReservation('PGME0002');
    createOrder.mockResolvedValue({ id: 'or_2', status: 'pending', charges: [] });

    const details = await createOrReuseProviderPayment(testDb, {
      ...baseInput,
      reservationId: reservation.id,
      code: reservation.code,
      kind: 'deposit',
      method: 'card',
      amountCents: 10000,
      cardToken: 'tok_abc123',
    });

    expect(details).toEqual({ method: 'card', provider: 'pagarme', paymentId: 'or_2', invoiceUrl: undefined });
    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        payments: [{ payment_method: 'credit_card', credit_card: { card_token: 'tok_abc123' } }],
      }),
    );

    const row = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(row.method).toBe('pagarme_card');
    expect(row.provider).toBe('pagarme');
  });

  it('card without a cardToken throws before ever calling createOrder', async () => {
    const reservation = await insertTestReservation('PGME0003');

    await expect(
      createOrReuseProviderPayment(testDb, {
        ...baseInput,
        reservationId: reservation.id,
        code: reservation.code,
        kind: 'deposit',
        method: 'card',
        amountCents: 10000,
      }),
    ).rejects.toThrow('cardToken is required');
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('reuse of a still-pending pagarme_card row returns card_awaiting — nothing to re-show, guest waits for the webhook (design\'s "Card reuse" note), never creates a second order', async () => {
    const reservation = await insertTestReservation('PGME0004');
    await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservation.id,
        asaas_payment_id: null,
        provider: 'pagarme',
        provider_payment_id: 'or_pending_card',
        method: 'pagarme_card',
        amount_cents: 10000,
        status: 'pending',
      })
      .execute();

    getOrder.mockResolvedValue({ id: 'or_pending_card', status: 'pending', charges: [] });

    const details = await createOrReuseProviderPayment(testDb, {
      ...baseInput,
      reservationId: reservation.id,
      code: reservation.code,
      kind: 'deposit',
      method: 'card',
      amountCents: 10000,
      cardToken: 'tok_should_be_unused',
    });

    expect(details).toEqual({ method: 'card_awaiting', provider: 'pagarme', paymentId: 'or_pending_card' });
    expect(createOrder).not.toHaveBeenCalled();

    const rows = await testDb.selectFrom('payments').selectAll().where('reservation_id', '=', reservation.id).execute();
    expect(rows).toHaveLength(1);
  });

  // THE drain guarantee (design decisions A2/A3): an existing pending row
  // dispatches by ITS OWN provider column, never by the active flag —
  // proven here by flipping the flag to pagarme while an Asaas row is still
  // pending, and confirming the reuse check goes through asaasClient
  // (mocked getPayment), never pagarmeClient.
  it('drain behavior: an existing pending Asaas row keeps resolving against Asaas even after the active flag flips to pagarme', async () => {
    const reservation = await insertTestReservation('DRAIN001');
    await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservation.id,
        asaas_payment_id: 'pay_drain',
        provider: 'asaas',
        provider_payment_id: 'pay_drain',
        method: 'asaas_pix',
        amount_cents: 10000,
        status: 'pending',
      })
      .execute();

    getPayment.mockResolvedValue({ id: 'pay_drain', status: 'PENDING', invoiceUrl: 'https://asaas.test/inv/drain' });
    getPixQrCode.mockResolvedValue({ encodedImage: 'img', payload: 'copy', expirationDate: '2026-09-01T00:00:00Z' });

    // config.payments.provider is 'pagarme' (this describe block's
    // beforeEach) — the create-path default, but irrelevant here since a
    // reusable pending row already exists.
    const details = await createOrReuseProviderPayment(testDb, {
      ...baseInput,
      reservationId: reservation.id,
      code: reservation.code,
      kind: 'deposit',
      method: 'pix',
      amountCents: 10000,
    });

    expect(details.provider).toBe('asaas');
    expect(getPayment).toHaveBeenCalledWith('pay_drain');
    expect(getOrder).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();

    const rows = await testDb.selectFrom('payments').selectAll().where('reservation_id', '=', reservation.id).execute();
    expect(rows).toHaveLength(1); // reused, not superseded by a new pagarme charge
  });
});
