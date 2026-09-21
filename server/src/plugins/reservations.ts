import type { FastifyError, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { createReservationWithCode } from '../reservations/createReservationWithCode.js';
import { NoAvailabilityError, MinStayNotMetError } from '../availability/createReservation.js';
import { eachNightUTC, todayISO } from '../shared/dateUtils.js';
import { getBusinessSettings } from '../settings/settings.js';
import {
  createOrReuseProviderPayment,
  PaymentAlreadyReceivedError,
  type PaymentDetails,
} from '../reservations/createOrReusePayment.js';
import { getPayment, AsaasApiError } from '../asaasClient.js';
import { PagarmeApiError } from '../pagarmeClient.js';
import { getProvider, type ProviderName } from '../payments/provider.js';
import { config } from '../config.js';

const MAX_NIGHTS = 60;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

// Babies (0-2) never count toward capacity and are informational only.
// Children (3-17) count toward capacity and their ages are stored
// as informative data (e.g. so staff can prepare a crib) — never
// affecting price/capacity beyond the headcount. 0-2 is excluded here
// on purpose: that range is a baby by definition, not a child, so the
// same age can never mean two different things.
const childAgeSchema = z.number().int().min(3).max(17);

// Defense-in-depth caps, not business rules — no real room sleeps anywhere
// near this many people. Without a ceiling, Zod fully validates (and the
// server fully allocates) a client-supplied array before the capacity check
// ever runs, which is an easy soft-DoS lever for attacker-controlled input.
const MAX_CHILDREN = 8;
const MAX_BABIES = 4;

const createReservationBodySchema = z
  .object({
    room_id: z.number().int().positive(),
    check_in: dateSchema,
    check_out: dateSchema,
    adults: z.number().int().min(1),
    children: z.number().int().min(0).max(MAX_CHILDREN).default(0),
    babies: z.number().int().min(0).max(MAX_BABIES).default(0),
    children_ages: z.array(childAgeSchema).max(MAX_CHILDREN).default([]),
    guest_name: z.string().min(3),
    guest_email: z.string().email(),
    guest_phone: z.string().min(8),
    notes: z.string().max(500).optional(),
  })
  .refine((data) => data.children_ages.length === data.children, {
    message: 'children_ages must have exactly one age per child',
    path: ['children_ages'],
  });

const reservationStatusSchema = z.enum([
  'pending_payment',
  'confirmed',
  'cancelled',
  'expired',
  'payment_conflict',
]);

// Shared by both responses below. Deliberately excludes children/babies/
// children_ages: the code-lookup GET is unauthenticated and shareable by
// design (it already excludes email/phone) — a reservation code isn't a
// strong secret (travels over WhatsApp, ends up in screenshots), so minors'
// ages/count don't belong in a response anyone holding the code can fetch.
// Only the 201 create response (returned once, to the guest who just
// submitted that exact data) includes them.
const reservationPublicFieldsSchema = z.object({
  code: z.string(),
  status: reservationStatusSchema,
  check_in: z.string(),
  check_out: z.string(),
  guests: z.number(),
  room: z.object({ id: z.number(), name: z.string() }),
  total_cents: z.number(),
  deposit_cents: z.number().nullable(),
  expires_at: z.string().nullable(),
});

const reservationResponseSchema = reservationPublicFieldsSchema.extend({
  children: z.number(),
  babies: z.number(),
  children_ages: z.array(z.number()),
});

const providerNameSchema = z.enum(['asaas', 'pagarme']);

// sdd/asaas-pagarme-migration task A15: widened for Pagar.me pix, which
// returns `qr_code`/`qr_code_url` (see pagarmeAdapter.ts's PixQrCode
// mapping) instead of Asaas's base64 `encoded_image` — `payload` (the EMV
// copy-paste string) is the one field both providers always populate.
// `encoded_image` becomes optional rather than removed: Asaas responses
// keep sending it exactly as before (additive widening, not a breaking
// change to the existing Asaas contract).
const pixDetailsSchema = z.object({
  encoded_image: z.string().optional(),
  payload: z.string(),
  expiration_date: z.string(),
  qr_code_url: z.string().optional(),
});

const reservationDetailResponseSchema = reservationPublicFieldsSchema.extend({
  payment_status: z.enum(['pending', 'received', 'failed', 'refunded']).nullable(),
  payment: z
    .object({
      method: z.enum(['pix', 'card']),
      pix: pixDetailsSchema.optional(),
      invoice_url: z.string().optional(),
    })
    .nullable(),
});

const createPaymentBodySchema = z.object({
  method: z.enum(['pix', 'card']),
  cpf_cnpj: z.string().min(11),
  // Only used for a Pagar.me card charge (design's on-site tokenized card
  // flow) — ignored for pix and for Asaas cards (Asaas's card flow doesn't
  // use a token). See provider.ts's PCI note.
  card_token: z.string().optional(),
});

const paymentResponseSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('pix'),
    payment_id: z.string(),
    provider: providerNameSchema,
    qr_code: pixDetailsSchema,
  }),
  z.object({
    method: z.literal('card'),
    payment_id: z.string(),
    provider: providerNameSchema,
    // invoice_url stays only on the asaas branch (design's Call-site
    // integration table) — optional here rather than removed, so the
    // Asaas response shape is unchanged.
    invoice_url: z.string().optional(),
  }),
  // sdd/asaas-pagarme-migration design's "Card reuse" note: a still-pending
  // pagarme_card charge has nothing to re-show (no redirect, no live
  // invoice) — this outcome tells the guest to keep waiting for the
  // webhook instead of a duplicate order being silently created.
  z.object({
    method: z.literal('card_awaiting'),
    payment_id: z.string(),
    provider: providerNameSchema,
  }),
]);

const paymentsConfigResponseSchema = z.object({
  provider: providerNameSchema,
  pagarme_public_key: z.string().optional(),
});

// Mirrors the CHECK constraint on payments.method (SPEC-modulo-7-gestion-
// operativa.md § 5.1, widened by sdd/asaas-pagarme-migration's migration to
// add pagarme_pix/pagarme_card — task A15). kysely-codegen doesn't turn a
// CHECK constraint into a TS literal union — payments.method is plain
// `string` at the type level — so this local type is what gives
// toPublicPaymentMethod's switch its exhaustiveness guarantee below: add a
// value to the CHECK constraint without adding a case to the switch, and
// the build stops compiling instead of silently dropping the new value.
//
// This exact class of gap — 7A widened payments.method from ('pix','card')
// to this wider set, and this file kept comparing the raw DB value against
// the old literal 'pix'/'card' — is what made this endpoint 500 for every
// reservation with an active payment (see server/CLAUDE.md "Deuda
// conocida"). Consumers of the public 'pix'/'card' contract this maps back
// to: ConfirmationStep.tsx (~L46/57, decides whether to show the PIX QR or
// the "awaiting card" state when the guest reloads) and ReservarPage.tsx
// (initial fetch after the Asaas card-payment redirect).
type KnownPaymentDbMethod = 'asaas_pix' | 'asaas_card' | 'pagarme_pix' | 'pagarme_card' | 'cash' | 'external' | 'pix_manual';

const KNOWN_PAYMENT_DB_METHODS = new Set<string>([
  'asaas_pix',
  'asaas_card',
  'pagarme_pix',
  'pagarme_card',
  'cash',
  'external',
  'pix_manual',
] satisfies KnownPaymentDbMethod[]);

function isKnownPaymentDbMethod(method: string): method is KnownPaymentDbMethod {
  return KNOWN_PAYMENT_DB_METHODS.has(method);
}

/** Only asaas_pix/asaas_card/pagarme_pix/pagarme_card have a live QR/invoice to show — manually-registered payments (§ 5.2 camino B) map to null on purpose. */
function toPublicPaymentMethod(dbMethod: KnownPaymentDbMethod): 'pix' | 'card' | null {
  switch (dbMethod) {
    case 'asaas_pix':
    case 'pagarme_pix':
      return 'pix';
    case 'asaas_card':
    case 'pagarme_card':
      return 'card';
    case 'cash':
    case 'external':
    case 'pix_manual':
      return null;
    default: {
      // Compile-time exhaustiveness check: if KnownPaymentDbMethod gains a
      // member without a case above, this line fails to compile.
      const exhaustive: never = dbMethod;
      throw new Error(`Unhandled payment method: ${String(exhaustive)}`);
    }
  }
}

function httpError(statusCode: number, message: string): FastifyError {
  const err = new Error(message) as FastifyError;
  err.statusCode = statusCode;
  err.code = 'RESERVATION_ERROR';
  err.name = 'ReservationError';
  return err;
}

function paymentDetailsToResponse(details: PaymentDetails) {
  if (details.method === 'pix') {
    return {
      method: 'pix' as const,
      payment_id: details.paymentId,
      provider: details.provider,
      qr_code: {
        encoded_image: details.qrCode.encodedImage,
        payload: details.qrCode.payload,
        expiration_date: details.qrCode.expirationDate,
        qr_code_url: details.qrCode.imageUrl,
      },
    };
  }
  if (details.method === 'card_awaiting') {
    return { method: 'card_awaiting' as const, payment_id: details.paymentId, provider: details.provider };
  }
  return {
    method: 'card' as const,
    payment_id: details.paymentId,
    provider: details.provider,
    invoice_url: details.invoiceUrl,
  };
}

export interface ReservationsPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const reservationsPlugin: FastifyPluginAsync<ReservationsPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/reservations',
    { schema: { body: createReservationBodySchema, response: { 201: reservationResponseSchema } } },
    async (request, reply) => {
      const {
        room_id,
        check_in,
        check_out,
        adults,
        children,
        babies,
        children_ages,
        guest_name,
        guest_email,
        guest_phone,
        notes,
      } = request.body;

      if (check_out <= check_in) {
        throw httpError(400, 'check_out must be after check_in');
      }
      const nights = eachNightUTC(check_in, check_out).length;
      if (nights > MAX_NIGHTS) {
        throw httpError(400, `Range cannot exceed ${MAX_NIGHTS} nights`);
      }
      if (check_in < todayISO()) {
        throw httpError(400, 'check_in cannot be in the past');
      }

      const room = await db
        .selectFrom('rooms')
        .select(['id', 'name', 'capacity', 'adults_only'])
        .where('id', '=', room_id)
        .where('active', '=', true)
        .executeTakeFirst();

      if (!room) {
        throw httpError(400, 'Room not found or inactive');
      }

      // Distinct rejection reason from capacity — this room type never
      // accepts children or babies, regardless of how much room is left.
      if (room.adults_only && (children > 0 || babies > 0)) {
        throw httpError(400, 'ADULTS_ONLY_ROOM: this room does not allow children or babies');
      }

      // Server derives `guests` itself — never trusts a client-supplied
      // value for the number that drives capacity and pricing.
      const guests = adults + children;
      if (guests > room.capacity) {
        throw httpError(400, `guests exceeds room capacity (${room.capacity})`);
      }

      try {
        const { depositPercent, holdMinutes } = await getBusinessSettings(db);
        const expiresAt = new Date(Date.now() + holdMinutes * 60 * 1000);
        const result = await createReservationWithCode(db, {
          roomId: room_id,
          checkIn: check_in,
          checkOut: check_out,
          guests,
          children,
          babies,
          childrenAges: children_ages,
          guestName: guest_name,
          guestEmail: guest_email,
          guestPhone: guest_phone,
          notes,
          expiresAt,
          depositPercent,
        });

        reply.status(201);
        return {
          code: result.code!,
          status: 'pending_payment' as const,
          check_in,
          check_out,
          guests,
          children,
          babies,
          children_ages,
          room: { id: room.id, name: room.name },
          total_cents: result.totalCents,
          deposit_cents: result.depositCents,
          expires_at: expiresAt.toISOString(),
        };
      } catch (err) {
        if (err instanceof NoAvailabilityError) {
          throw httpError(409, 'NO_AVAILABILITY');
        }
        if (err instanceof MinStayNotMetError) {
          throw httpError(
            400,
            `Stay of ${err.requestedNights} nights is below the ${err.requiredMinStay}-night minimum`,
          );
        }
        throw err;
      }
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/reservations/:code',
    { schema: { params: z.object({ code: z.string() }), response: { 200: reservationDetailResponseSchema } } },
    async (request) => {
      const { code } = request.params;

      const row = await db
        .selectFrom('reservations')
        .innerJoin('rooms', 'rooms.id', 'reservations.room_id')
        .select([
          'reservations.id as reservation_id',
          'reservations.status',
          sql<string>`reservations.check_in::text`.as('check_in'),
          sql<string>`reservations.check_out::text`.as('check_out'),
          'reservations.guests',
          'reservations.total_cents',
          'reservations.deposit_cents',
          'reservations.expires_at',
          'rooms.id as room_id',
          'rooms.name as room_name',
        ])
        .where('reservations.code', '=', code)
        .executeTakeFirst();

      if (!row) {
        throw httpError(404, 'Reservation not found');
      }

      const isExpired =
        row.status === 'pending_payment' && row.expires_at != null && new Date(row.expires_at) <= new Date();

      const activePayment = await db
        .selectFrom('payments')
        .selectAll()
        .where('reservation_id', '=', row.reservation_id)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();

      let payment: z.infer<typeof reservationDetailResponseSchema>['payment'] = null;
      if (activePayment) {
        if (!isKnownPaymentDbMethod(activePayment.method)) {
          // Never seen before (DB drifted ahead of this code, e.g. a new
          // CHECK constraint value with no matching case yet) — fail soft.
          // payment_status below still reflects the payment; only the
          // live-QR/invoice enrichment is skipped. This endpoint must never
          // 500 again over an unmapped method value.
          fastify.log.warn({ method: activePayment.method }, 'unrecognized payment method on public reservation lookup');
        } else {
          const publicMethod = toPublicPaymentMethod(activePayment.method);

          // Only worth a live round-trip while the payment is still
          // actionable by the guest (pending) — avoids hammering the
          // provider from frontend polling once the payment is settled
          // either way. sdd/asaas-pagarme-migration task A15/A17: the
          // provider-agnostic lookup now dispatches by `activePayment.provider`
          // instead of assuming Asaas — both PR1's migration backfill and
          // A11's writes guarantee `provider`/`provider_payment_id` are set
          // on every row this branch can reach (isKnownPaymentDbMethod
          // already excludes cash/external/pix_manual, per § 5.2 camino B,
          // which are always inserted as 'received', never 'pending').
          if (publicMethod) {
            payment = { method: publicMethod };

            if (activePayment.status === 'pending' && activePayment.provider && activePayment.provider_payment_id) {
              const providerName = activePayment.provider as ProviderName;
              const providerPaymentId = activePayment.provider_payment_id;
              try {
                if (publicMethod === 'pix') {
                  const adapter = getProvider(providerName);
                  const qr = await adapter.fetchPixDetails?.(providerPaymentId);
                  if (qr) {
                    payment.pix = {
                      encoded_image: qr.encodedImage,
                      payload: qr.payload,
                      expiration_date: qr.expirationDate,
                      qr_code_url: qr.imageUrl,
                    };
                  }
                } else if (providerName === 'asaas') {
                  // Only Asaas has a live invoice_url to re-show — Pagar.me
                  // card confirms exclusively via webhook (design's Data
                  // Flow / security rule), nothing to refresh here for a
                  // pagarme_card row.
                  const remote = await getPayment(providerPaymentId);
                  payment.invoice_url = remote.invoiceUrl;
                }
              } catch (err) {
                if (err instanceof AsaasApiError) {
                  // Don't log `err` whole — AsaasApiError.body carries the
                  // guest's PII (name/email/phone/CPF) echoed back by Asaas.
                  fastify.log.warn({ status: err.status }, 'failed to refresh live payment details from Asaas');
                } else if (err instanceof PagarmeApiError) {
                  fastify.log.warn({ status: err.status }, 'failed to refresh live payment details from Pagar.me');
                } else {
                  throw err;
                }
              }
            }
          }
          // publicMethod === null (cash/external/pix_manual): no live
          // QR/invoice to show — `payment` stays null, payment_status alone
          // already reflects it.
        }
      }

      return {
        code,
        status: isExpired
          ? ('expired' as const)
          : (row.status as 'pending_payment' | 'confirmed' | 'cancelled' | 'payment_conflict'),
        check_in: row.check_in,
        check_out: row.check_out,
        guests: row.guests,
        room: { id: row.room_id, name: row.room_name },
        total_cents: row.total_cents,
        deposit_cents: row.deposit_cents,
        expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
        payment_status: activePayment ? (activePayment.status as 'pending' | 'received' | 'failed' | 'refunded') : null,
        payment,
      };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/reservations/:code/payment',
    {
      schema: {
        params: z.object({ code: z.string() }),
        body: createPaymentBodySchema,
        response: { 201: paymentResponseSchema },
      },
    },
    async (request, reply) => {
      const { code } = request.params;
      const { method, cpf_cnpj, card_token } = request.body;

      const row = await db
        .selectFrom('reservations')
        .select(['id', 'status', 'expires_at', 'deposit_cents', 'guest_name', 'guest_email', 'guest_phone'])
        .where('code', '=', code)
        .executeTakeFirst();

      if (!row) {
        throw httpError(404, 'Reservation not found');
      }

      if (row.status !== 'pending_payment' || row.expires_at == null || new Date(row.expires_at) <= new Date()) {
        throw httpError(409, 'RESERVATION_NOT_PAYABLE');
      }
      if (row.deposit_cents == null) {
        throw httpError(409, 'DEPOSIT_NOT_CONFIGURED');
      }
      const expiresAt = row.expires_at;

      try {
        const details = await createOrReuseProviderPayment(db, {
          reservationId: row.id,
          code,
          kind: 'deposit',
          method,
          amountCents: row.deposit_cents,
          dueDate: new Date(expiresAt).toISOString().slice(0, 10),
          guestName: row.guest_name ?? '',
          guestEmail: row.guest_email ?? '',
          guestPhone: row.guest_phone ?? '',
          cpfCnpj: cpf_cnpj,
          cardToken: card_token,
        });

        reply.status(201);
        return paymentDetailsToResponse(details);
      } catch (err) {
        if (err instanceof PaymentAlreadyReceivedError) {
          throw httpError(409, 'PAYMENT_ALREADY_RECEIVED');
        }
        if (err instanceof AsaasApiError) {
          // Keep the real Asaas error out of the client response (it can
          // echo back request data) but not out of our own logs — losing it
          // here means nobody can tell why a charge failed without going to
          // the Asaas dashboard.
          request.log.warn({ status: err.status, body: err.body }, 'asaas_request_failed');
          throw httpError(502, 'asaas_request_failed');
        }
        if (err instanceof PagarmeApiError) {
          // Same reasoning as AsaasApiError above — PagarmeApiError carries
          // the RESPONSE body only (never the request body, which can hold
          // a card_token — see pagarmeClient.ts's PCI note), but still not
          // safe to echo to the client.
          request.log.warn({ status: err.status, body: err.body }, 'pagarme_request_failed');
          throw httpError(502, 'pagarme_request_failed');
        }
        throw err;
      }
    },
  );

  // sdd/asaas-pagarme-migration task A15 — lets the frontend learn the
  // active provider from the API rather than a Vite build-time flag
  // (design decision A4): a rollback is then one backend env var + restart,
  // never a frontend rebuild+deploy.
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/payments/config',
    { schema: { response: { 200: paymentsConfigResponseSchema } } },
    async () => ({
      provider: config.payments.provider,
      pagarme_public_key: config.payments.provider === 'pagarme' ? config.pagarme.publicKey : undefined,
    }),
  );
};

export default reservationsPlugin;
