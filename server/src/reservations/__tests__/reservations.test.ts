import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from '@fastify/type-provider-zod';
import { sql } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb, testPool } from '../../db/testClient.js';
import { registerErrorHandler } from '../../errorHandler.js';
import { addDaysUTC, formatDateUTC, parseDateUTC, todayISO } from '../../shared/dateUtils.js';
import { calculatePrice } from '../../pricing/calculatePrice.js';

// Hardcoded absolute dates are a time bomb: this file used to read
// check_in: '2026-09-01' everywhere, which was safely in the future when
// written but eventually became "today" and then the past, making
// `check_in cannot be in the past` (src/plugins/reservations.ts) fail every
// POST test in this file with a 400 instead of their expected status — not
// a code regression, just the wall clock catching up to a literal. Computed
// relative to todayISO() instead, same pattern already used in
// panelTapeChart.test.ts / panelRateOverrides.test.ts. CHECK_IN is
// tomorrow, not today, to keep a full day of buffer against the UTC
// midnight boundary (real machine clocks run ahead of a session's stated
// "today" — this is exactly what broke here).
const CHECK_IN = formatDateUTC(addDaysUTC(parseDateUTC(todayISO()), 1));
const CHECK_OUT = formatDateUTC(addDaysUTC(parseDateUTC(todayISO()), 3));

// CHECK_IN/CHECK_OUT float with the real calendar, so which of their two
// nights land on the Friday/Saturday weekend rate (calculatePrice.ts)
// shifts week to week — a hardcoded expected total would just trade one
// time bomb for another. Mirrors insertTestRoom's default fixture
// (capacity 2 ⇒ occupancy 2, weekday_cents 10000, weekend_cents 15000, no
// overrides) so the two stay in sync if that fixture ever changes.
const EXPECTED_TOTAL_CENTS = (() => {
  const result = calculatePrice({
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    guests: 2,
    roomRates: [{ occupancy: 2, weekdayCents: 10000, weekendCents: 15000 }],
    rateOverrides: [],
    roomDefaultMinStay: 1,
  });
  if (result.status !== 'available') throw new Error(`Unexpected calculatePrice status: ${result.status}`);
  return result.totalCents;
})();

const getPixQrCode = vi.fn();
const getPayment = vi.fn();

// Only getPixQrCode/getPayment are mocked (createCustomer/createPayment
// aren't touched by this file's tests) — the live-enrichment branch of
// GET /api/reservations/:code is what regression-tests the method-mapping
// fix below; no other test in this file reaches Asaas at all.
vi.mock('../../asaasClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../asaasClient.js')>();
  return {
    ...actual,
    getPixQrCode: (...args: unknown[]) => getPixQrCode(...args),
    getPayment: (...args: unknown[]) => getPayment(...args),
  };
});

const { default: reservationsPlugin } = await import('../../plugins/reservations.js');

function buildApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(reservationsPlugin, { prefix: '/api', db: testDb });
  registerErrorHandler(app);
  return app;
}

async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE reservations, rate_overrides, room_rates, rooms RESTART IDENTITY CASCADE`.execute(
    testDb,
  );
}

interface RoomFixtureOptions {
  totalUnits?: number;
  capacity?: number;
  adultsOnly?: boolean;
}

async function insertTestRoom(options: RoomFixtureOptions = {}): Promise<number> {
  const capacity = options.capacity ?? 2;
  const totalUnits = options.totalUnits ?? 3;
  const room = await testDb
    .insertInto('rooms')
    .values({
      name: 'TestRoom',
      capacity,
      pets_allowed: false,
      adults_only: options.adultsOnly ?? false,
      default_min_stay: 1,
      total_units: totalUnits,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await testDb
    .insertInto('room_rates')
    .values({ room_id: room.id, occupancy: capacity, weekday_cents: 10000, weekend_cents: 15000 })
    .execute();

  // Módulo 5: totalUnits is now derived from active room_units, not the
  // rooms.total_units column — create matching physical units so this
  // endpoint's existing tests keep their exact original behavior.
  if (totalUnits > 0) {
    await testDb
      .insertInto('room_units')
      .values(
        Array.from({ length: totalUnits }, (_, i) => ({
          room_id: room.id,
          label: `${room.id}-${i + 1}`,
        })),
      )
      .execute();
  }

  return room.id;
}

const validGuest = {
  guest_name: 'Maria Silva',
  guest_email: 'maria@example.com',
  guest_phone: '11999998888',
};

beforeEach(async () => {
  await resetDb();
});

describe('POST /api/reservations', () => {
  it('happy path creates a reservation with a code and a 30-minute expiry', async () => {
    const roomId = await insertTestRoom({ totalUnits: 3 });
    const app = buildApp();

    const before = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      payload: { room_id: roomId, check_in: CHECK_IN, check_out: CHECK_OUT, adults: 2, ...validGuest },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(body.status).toBe('pending_payment');
    expect(body.total_cents).toBe(EXPECTED_TOTAL_CENTS);
    // Módulo 5: the guest reserves a TYPE, never a physical unit — the
    // create response must never leak the internal assignment.
    expect(body).not.toHaveProperty('room_unit_id');

    const expiresAt = new Date(body.expires_at).getTime();
    expect(expiresAt).toBeGreaterThan(before + 29 * 60 * 1000);
    expect(expiresAt).toBeLessThan(before + 31 * 60 * 1000);
  });

  it('rejects guests over room capacity with 400', async () => {
    const roomId = await insertTestRoom({ capacity: 2 });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      payload: { room_id: roomId, check_in: CHECK_IN, check_out: CHECK_OUT, adults: 3, ...validGuest },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects children on an adults-only room with 400', async () => {
    const roomId = await insertTestRoom({ capacity: 2, adultsOnly: true });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      payload: {
        room_id: roomId,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        adults: 1,
        children: 1,
        children_ages: [5],
        ...validGuest,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('ADULTS_ONLY_ROOM');
  });

  it('rejects babies on an adults-only room with 400', async () => {
    const roomId = await insertTestRoom({ capacity: 2, adultsOnly: true });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      payload: {
        room_id: roomId,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        adults: 2,
        babies: 1,
        ...validGuest,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('ADULTS_ONLY_ROOM');
  });

  it('rejects children_ages length mismatched with children count', async () => {
    const roomId = await insertTestRoom({ capacity: 4 });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      payload: {
        room_id: roomId,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        adults: 2,
        children: 2,
        children_ages: [5],
        ...validGuest,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it.each([
    ['too young (2, a baby not a child)', 2],
    ['too old (18)', 18],
  ])('rejects a child age of %s with 400', async (_label, age) => {
    const roomId = await insertTestRoom({ capacity: 3 });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      payload: {
        room_id: roomId,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        adults: 1,
        children: 1,
        children_ages: [age],
        ...validGuest,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('happy path with children and babies on a non-adults-only room, guests derived server-side', async () => {
    const roomId = await insertTestRoom({ capacity: 4, adultsOnly: false });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      payload: {
        room_id: roomId,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        adults: 2,
        children: 2,
        babies: 1,
        children_ages: [5, 10],
        ...validGuest,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.guests).toBe(4); // 2 adults + 2 children — babies never count
    expect(body.children).toBe(2);
    expect(body.babies).toBe(1);
    expect(body.children_ages.slice().sort((a: number, b: number) => a - b)).toEqual([5, 10]);
  });

  it('rejects with 409 NO_AVAILABILITY when the range is full, and leaves no new row behind', async () => {
    const roomId = await insertTestRoom({ totalUnits: 1 });
    await testDb
      .insertInto('reservations')
      .values({
        room_id: roomId,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        guests: 2,
        status: 'confirmed',
        total_cents: 10000,
        code: null,
      })
      .execute();

    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      payload: { room_id: roomId, check_in: CHECK_IN, check_out: CHECK_OUT, adults: 2, ...validGuest },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('NO_AVAILABILITY');

    const count = await testDb
      .selectFrom('reservations')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('room_id', '=', roomId)
      .where('status', '!=', 'cancelled')
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(1); // only the pre-existing confirmed row
  });

  it.each([
    ['invalid email', { guest_email: 'not-an-email' }],
    ['short name', { guest_name: 'Al' }],
    ['inverted range', { check_in: CHECK_OUT, check_out: CHECK_IN }],
  ])('rejects %s with 400 and a per-field message', async (_label, override) => {
    const roomId = await insertTestRoom();
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      payload: {
        room_id: roomId,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        adults: 2,
        ...validGuest,
        ...override,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBeTruthy();
  });
});

describe('GET /api/reservations/:code', () => {
  it('returns a safe shape (no email/phone/id) and 404 when missing', async () => {
    const roomId = await insertTestRoom();
    const app = buildApp();

    const created = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      payload: { room_id: roomId, check_in: CHECK_IN, check_out: CHECK_OUT, adults: 2, ...validGuest },
    });
    const { code } = created.json();

    const response = await app.inject({ method: 'GET', url: `/api/reservations/${code}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.code).toBe(code);
    expect(body).not.toHaveProperty('guest_email');
    expect(body).not.toHaveProperty('guest_phone');
    expect(body).not.toHaveProperty('id');
    // Public, unauthenticated lookup by code — never a place to learn
    // whether a reservation has children/babies or their ages.
    expect(body).not.toHaveProperty('children');
    expect(body).not.toHaveProperty('babies');
    expect(body).not.toHaveProperty('children_ages');
    // Módulo 5: same defensive pattern — the unit is internal information,
    // never surfaced on the public code-lookup endpoint either.
    expect(body).not.toHaveProperty('room_unit_id');

    const missing = await app.inject({ method: 'GET', url: '/api/reservations/NOPE0000' });
    expect(missing.statusCode).toBe(404);
  });

  it('reports status "expired" once expires_at is in the past, without writing the row', async () => {
    const roomId = await insertTestRoom();
    const inserted = await testDb
      .insertInto('reservations')
      .values({
        room_id: roomId,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        guests: 2,
        status: 'pending_payment',
        expires_at: new Date(Date.now() - 60_000),
        total_cents: 20000,
        code: 'EXPIRED1',
      })
      .returning('status')
      .executeTakeFirstOrThrow();

    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/reservations/EXPIRED1' });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('expired');
    expect(inserted.status).toBe('pending_payment'); // the row itself was never touched
  });

  // Regression: 7A widened payments.method from ('pix','card') to
  // ('asaas_pix','asaas_card','cash','external','pix_manual'), but this
  // endpoint kept comparing the raw DB value against the old literal
  // 'pix'/'card' and cast it straight into the response — Zod's response
  // serializer (z.enum(['pix','card'])) threw on the mismatch, turning this
  // into a bare 500 for every reservation with an active payment. See
  // server/CLAUDE.md "Deuda conocida".
  it('maps a pending asaas_pix payment to the public "pix" method instead of 500ing', async () => {
    const roomId = await insertTestRoom();
    const reservation = await testDb
      .insertInto('reservations')
      .values({
        room_id: roomId,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        guests: 2,
        status: 'pending_payment',
        expires_at: new Date(Date.now() + 30 * 60 * 1000),
        total_cents: 20000,
        deposit_cents: 10000,
        code: 'PIXOK001',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservation.id,
        asaas_payment_id: 'pay_regress_1',
        method: 'asaas_pix',
        amount_cents: 10000,
        status: 'pending',
      })
      .execute();
    getPixQrCode.mockResolvedValue({ encodedImage: 'img', payload: 'copy', expirationDate: '2026-09-01T00:00:00Z' });

    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/reservations/PIXOK001' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.payment).toEqual({
      method: 'pix',
      pix: { encoded_image: 'img', payload: 'copy', expiration_date: '2026-09-01T00:00:00Z' },
    });
    expect(body.payment_status).toBe('pending');
  });

  // Same regression as above, but the reported bug was specifically with
  // card payments (the asaas_pix test alone would still pass with the
  // original bug in place, since it never reaches the invoice_url/getPayment
  // branch below).
  it('maps a pending asaas_card payment to the public "card" method instead of 500ing', async () => {
    const roomId = await insertTestRoom();
    const reservation = await testDb
      .insertInto('reservations')
      .values({
        room_id: roomId,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        guests: 2,
        status: 'pending_payment',
        expires_at: new Date(Date.now() + 30 * 60 * 1000),
        total_cents: 20000,
        deposit_cents: 10000,
        code: 'CARDOK01',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await testDb
      .insertInto('payments')
      .values({
        reservation_id: reservation.id,
        asaas_payment_id: 'pay_regress_2',
        method: 'asaas_card',
        amount_cents: 10000,
        status: 'pending',
      })
      .execute();
    getPayment.mockResolvedValue({ invoiceUrl: 'https://asaas.example/invoice/pay_regress_2' });

    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/reservations/CARDOK01' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.payment).toEqual({
      method: 'card',
      invoice_url: 'https://asaas.example/invoice/pay_regress_2',
    });
    expect(body.payment_status).toBe('pending');
  });

  it.each(['cash', 'external', 'pix_manual'] as const)(
    'maps a %s payment to payment: null, keeping payment_status as the source of truth',
    async (method) => {
      const roomId = await insertTestRoom();
      const reservation = await testDb
        .insertInto('reservations')
        .values({
          room_id: roomId,
          check_in: CHECK_IN,
          check_out: CHECK_OUT,
          guests: 2,
          status: 'pending_payment',
          expires_at: new Date(Date.now() + 30 * 60 * 1000),
          total_cents: 20000,
          deposit_cents: 10000,
          code: `MAN${method.slice(0, 5).toUpperCase()}`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await testDb
        .insertInto('payments')
        .values({
          reservation_id: reservation.id,
          asaas_payment_id: `pay_${method}`,
          method,
          amount_cents: 10000,
          status: 'received',
        })
        .execute();

      const app = buildApp();
      const response = await app.inject({
        method: 'GET',
        url: `/api/reservations/MAN${method.slice(0, 5).toUpperCase()}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.payment).toBeNull();
      expect(body.payment_status).toBe('received');
    },
  );

  // The fail-soft this endpoint depends on: an unrecognized DB value for
  // payments.method (DB drifted ahead of this code) must degrade to
  // payment: null, never 500 — this is the exact failure mode the original
  // bug produced, just triggered by a hypothetical future value instead of
  // asaas_pix/asaas_card.
  it('fails soft to payment: null on an unrecognized payment method instead of 500ing', async () => {
    const roomId = await insertTestRoom();
    const reservation = await testDb
      .insertInto('reservations')
      .values({
        room_id: roomId,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        guests: 2,
        status: 'pending_payment',
        expires_at: new Date(Date.now() + 30 * 60 * 1000),
        total_cents: 20000,
        deposit_cents: 10000,
        code: 'UNKNOWN1',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // payments.method has a CHECK constraint, so a genuinely unmapped value
    // can only exist if the DB drifts ahead of this code (a migration adds a
    // new allowed value before this file grows a matching case). Simulate
    // that drift directly: drop the constraint, insert the unmapped value,
    // restore it — this is the exact scenario the fail-soft path exists for.
    await sql`ALTER TABLE payments DROP CONSTRAINT payments_method_check`.execute(testDb);
    try {
      await sql`
        INSERT INTO payments (reservation_id, asaas_payment_id, method, amount_cents, status)
        VALUES (${reservation.id}, ${'pay_unknown'}, ${'boleto'}, ${10000}, ${'pending'})
      `.execute(testDb);

      const app = buildApp();
      const response = await app.inject({ method: 'GET', url: '/api/reservations/UNKNOWN1' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.payment).toBeNull();
      expect(body.payment_status).toBe('pending');
    } finally {
      // ADD CONSTRAINT re-validates every existing row, including the one
      // just inserted above — delete it first or the restore itself fails.
      await sql`DELETE FROM payments WHERE asaas_payment_id = ${'pay_unknown'}`.execute(testDb);
      await sql`
        ALTER TABLE payments ADD CONSTRAINT payments_method_check
        CHECK (method IN ('asaas_pix','asaas_card','cash','external','pix_manual'))
      `.execute(testDb);
    }
  });
});

describe('POST /api/reservations/:code/payment', () => {
  it('404 when the reservation does not exist', async () => {
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/reservations/NOPE0000/payment',
      payload: { method: 'pix', cpf_cnpj: '12345678900' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('409 when the reservation is already confirmed', async () => {
    const roomId = await insertTestRoom();
    const inserted = await testDb
      .insertInto('reservations')
      .values({
        room_id: roomId,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        guests: 2,
        status: 'confirmed',
        total_cents: 20000,
        deposit_cents: 10000,
        code: 'CONFIRM1',
      })
      .returning('code')
      .executeTakeFirstOrThrow();

    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/reservations/${inserted.code}/payment`,
      payload: { method: 'pix', cpf_cnpj: '12345678900' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('RESERVATION_NOT_PAYABLE');
  });

  it('409 when the reservation already expired', async () => {
    const roomId = await insertTestRoom();
    const inserted = await testDb
      .insertInto('reservations')
      .values({
        room_id: roomId,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        guests: 2,
        status: 'pending_payment',
        expires_at: new Date(Date.now() - 60_000),
        total_cents: 20000,
        deposit_cents: 10000,
        code: 'EXPIRED2',
      })
      .returning('code')
      .executeTakeFirstOrThrow();

    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/reservations/${inserted.code}/payment`,
      payload: { method: 'pix', cpf_cnpj: '12345678900' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('RESERVATION_NOT_PAYABLE');
  });
});

describe('POST /api/reservations — concurrency', () => {
  it('with 1 unit left, exactly one of two simultaneous requests wins, over two distinct pool connections', async () => {
    const roomId = await insertTestRoom({ totalUnits: 1 });
    const app = buildApp();

    const payload = {
      room_id: roomId,
      check_in: CHECK_IN,
      check_out: CHECK_OUT,
      adults: 2,
      ...validGuest,
    };

    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/reservations', payload }),
      app.inject({ method: 'POST', url: '/api/reservations', payload }),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);

    // Proves the two concurrent requests weren't just serialized through a
    // single pooled connection — the pool had to open a second physical
    // connection to serve both at once, which is what actually exercises
    // the `FOR UPDATE` row lock instead of trivial in-process ordering.
    expect(testPool.totalCount).toBeGreaterThanOrEqual(2);

    const activeCount = await testDb
      .selectFrom('reservations')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('room_id', '=', roomId)
      .where('status', '!=', 'cancelled')
      .executeTakeFirstOrThrow();
    expect(Number(activeCount.count)).toBe(1);
  });
});
