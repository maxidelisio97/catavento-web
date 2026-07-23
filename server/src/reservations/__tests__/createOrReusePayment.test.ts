/**
 * Characterization test written BEFORE generalizing `createOrReusePayment`
 * (now `createOrReuseAsaasPayment`) for SPEC-modulo-7-gestion-operativa.md
 * § 5.4 (kind/method payments beyond the M4 deposit). Locks down the
 * deposit path's behavior — DB method mapping, the "reuse a live pending
 * payment" rule, and the inserted row shape — so the 7B generalization
 * can't silently change it.
 */
import { sql } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../db/testClient.js';

const createCustomer = vi.fn();
const createPayment = vi.fn();
const getPayment = vi.fn();
const getPixQrCode = vi.fn();

vi.mock('../../asaasClient.js', () => ({
  createCustomer: (...args: unknown[]) => createCustomer(...args),
  createPayment: (...args: unknown[]) => createPayment(...args),
  getPayment: (...args: unknown[]) => getPayment(...args),
  getPixQrCode: (...args: unknown[]) => getPixQrCode(...args),
}));

const { createOrReuseAsaasPayment, PaymentAlreadyReceivedError } = await import('../createOrReusePayment.js');

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE payments, reservations, rate_overrides, room_rates, rooms RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

async function insertTestReservation(): Promise<{ id: number; code: string }> {
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
      code: 'TEST0001',
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
});

describe('createOrReuseAsaasPayment — deposit characterization (pre-7B baseline)', () => {
  it('pix: creates a customer + PIX payment, inserts a pending deposit row mapped to asaas_pix', async () => {
    const reservation = await insertTestReservation();
    createCustomer.mockResolvedValue({ id: 'cus_1' });
    createPayment.mockResolvedValue({ id: 'pay_1', status: 'PENDING', invoiceUrl: 'https://asaas.test/inv/1' });
    getPixQrCode.mockResolvedValue({
      encodedImage: 'img',
      payload: 'copy-paste',
      expirationDate: '2026-09-01T00:00:00Z',
    });

    const details = await createOrReuseAsaasPayment(testDb, {
      ...baseInput,
      reservationId: reservation.id,
      code: reservation.code,
      kind: 'deposit',
      method: 'pix',
      amountCents: 10000,
    });

    expect(details).toEqual({
      method: 'pix',
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
    expect(row.method).toBe('asaas_pix');
    expect(row.kind).toBe('deposit');
    expect(row.amount_cents).toBe(10000);
    expect(row.status).toBe('pending');
  });

  it('card: maps method to asaas_card and returns invoiceUrl', async () => {
    const reservation = await insertTestReservation();
    createCustomer.mockResolvedValue({ id: 'cus_1' });
    createPayment.mockResolvedValue({ id: 'pay_2', status: 'PENDING', invoiceUrl: 'https://asaas.test/inv/2' });

    const details = await createOrReuseAsaasPayment(testDb, {
      ...baseInput,
      reservationId: reservation.id,
      code: reservation.code,
      kind: 'deposit',
      method: 'card',
      amountCents: 10000,
    });

    expect(details).toEqual({ method: 'card', paymentId: 'pay_2', invoiceUrl: 'https://asaas.test/inv/2' });
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ billingType: 'CREDIT_CARD' }));

    const row = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('reservation_id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    expect(row.method).toBe('asaas_card');
  });

  it('reuses a still-pending Asaas charge instead of creating a second one', async () => {
    const reservation = await insertTestReservation();
    await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservation.id,
        asaas_payment_id: 'pay_existing',
        method: 'asaas_pix',
        amount_cents: 10000,
        status: 'pending',
      })
      .execute();

    getPayment.mockResolvedValue({ id: 'pay_existing', status: 'PENDING', invoiceUrl: 'https://asaas.test/inv/x' });
    getPixQrCode.mockResolvedValue({ encodedImage: 'img', payload: 'copy', expirationDate: '2026-09-01T00:00:00Z' });

    await createOrReuseAsaasPayment(testDb, {
      ...baseInput,
      reservationId: reservation.id,
      code: reservation.code,
      kind: 'deposit',
      method: 'pix',
      amountCents: 10000,
    });

    expect(createCustomer).not.toHaveBeenCalled();
    expect(createPayment).not.toHaveBeenCalled();

    const rows = await testDb.selectFrom('payments').selectAll().where('reservation_id', '=', reservation.id).execute();
    expect(rows).toHaveLength(1);
  });

  it('throws PaymentAlreadyReceivedError when Asaas already has the money (known bug: the "mark received" UPDATE runs inside the same tx as the throw, so it rolls back and never persists — see server/CLAUDE.md "deuda conocida")', async () => {
    const reservation = await insertTestReservation();
    await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservation.id,
        asaas_payment_id: 'pay_existing',
        method: 'asaas_pix',
        amount_cents: 10000,
        status: 'pending',
      })
      .execute();

    getPayment.mockResolvedValue({ id: 'pay_existing', status: 'RECEIVED', invoiceUrl: 'https://asaas.test/inv/x' });

    await expect(
      createOrReuseAsaasPayment(testDb, {
        ...baseInput,
        reservationId: reservation.id,
        code: reservation.code,
        kind: 'deposit',
        method: 'pix',
        amountCents: 10000,
      }),
    ).rejects.toBeInstanceOf(PaymentAlreadyReceivedError);

    // NOT 'received': the UPDATE that sets it happens right before the throw
    // above, inside the same transaction — Kysely rolls it back along with
    // everything else in this callback. This locks down actual behavior, not
    // the intent in the code's comment.
    const row = await testDb
      .selectFrom('payments')
      .selectAll()
      .where('asaas_payment_id', '=', 'pay_existing')
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
  });
});
