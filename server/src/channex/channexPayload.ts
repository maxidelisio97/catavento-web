/**
 * Maps a raw Channex Booking Revision payload (webhook body or one feed
 * item) into `ChannexBookingRevisionInput` (processBookingRevision.ts) —
 * kept in this ONE file specifically so a field-name mismatch found against
 * a real payload is a one-file fix, not a hunt through transaction logic.
 *
 * ⚠️ NOT VERIFIED AGAINST A REAL CHANNEX PAYLOAD. Field names below are
 * based on SPEC-modulo-12B-reservas-entrantes.md § 1 ("booking.id,
 * revision_id, status, rooms[].room_type_id") and Channex's published API
 * shape, but this repo has never received (or captured) a real webhook
 * delivery or feed response from Channex. Before relying on this in
 * production: trigger a real test booking against the staging property,
 * capture the actual webhook body AND a real `/booking_revisions/feed`
 * response, and adjust the field paths below to match — do not assume this
 * guess is correct just because it type-checks.
 */
import type { ChannexBookingRevisionInput } from './processBookingRevision.js';

interface RawChannexRoom {
  room_type_id?: string;
  channex_room_type_id?: string;
  [key: string]: unknown;
}

interface RawChannexBooking {
  id?: string;
  booking_id?: string;
  revision_id?: string;
  status?: string;
  rooms?: RawChannexRoom[];
  checkin_date?: string;
  checkout_date?: string;
  arrival_date?: string;
  departure_date?: string;
  occupancy?: { adults?: number; children?: number };
  amount?: number | string;
  amount_cents?: number;
  customer?: { name?: string; mail?: string; phone?: string };
  [key: string]: unknown;
}

const STATUS_MAP: Record<string, ChannexBookingRevisionInput['status']> = {
  new: 'new',
  created: 'new',
  modified: 'modified',
  modification: 'modified',
  updated: 'modified',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

function toDateOnly(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Accepts both 'YYYY-MM-DD' and an ISO timestamp — takes the date part only.
  return value.slice(0, 10);
}

function toCents(amount: number | string | undefined): number | undefined {
  if (amount === undefined) return undefined;
  const asNumber = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(asNumber)) return undefined;
  // Channex typically reports amounts as decimal currency units (e.g. 350.00),
  // same convention as Asaas's API — converted to cents like the rest of this
  // codebase (server/CLAUDE.md: "Dinero: centavos como INTEGER").
  return Math.round(asNumber * 100);
}

/**
 * Returns `null` for anything that isn't a processable revision: missing
 * required fields, or a shape this parser doesn't recognize at all.
 *
 * Risk-review finding (pre-merge, fresh-context review): the raw shape is,
 * by this file's own docstring, UNVERIFIED against a real Channex payload —
 * so this wraps the actual parsing in a try/catch and never lets a
 * malformed/unexpected-type field (e.g. `status` arriving as a number
 * instead of a string) throw out to the caller. Both the webhook
 * (§ 3.2: "responder 200 aunque haya overbooking del lado del PMS", i.e.
 * never let a body-shape surprise become a 5xx to Channex) and the pull
 * (one bad feed item must not abort the rest of the batch) depend on this
 * function never throwing.
 */
export function parseChannexBookingRevision(raw: unknown): ChannexBookingRevisionInput | null {
  try {
    return parseChannexBookingRevisionUnsafe(raw);
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseChannexBookingRevisionUnsafe(raw: unknown): ChannexBookingRevisionInput | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const body = raw as { booking?: RawChannexBooking } & RawChannexBooking;
  const booking = body.booking ?? body;
  if (typeof booking !== 'object' || booking === null) return null;

  const bookingId = booking.booking_id ?? booking.id;
  const revisionId = booking.revision_id;
  const rawStatus = booking.status;

  if (!isNonEmptyString(bookingId) || !isNonEmptyString(revisionId) || !isNonEmptyString(rawStatus)) return null;

  const status = STATUS_MAP[rawStatus.toLowerCase()];
  if (!status) return null;

  if (status === 'cancelled') {
    return { bookingId, revisionId, status };
  }

  const rooms = Array.isArray(booking.rooms) ? booking.rooms : [];
  if (rooms.length > 1) {
    return { bookingId, revisionId, status, multiRoom: true };
  }

  const room = rooms[0];
  const channexRoomTypeId = room?.room_type_id ?? room?.channex_room_type_id;
  const checkIn = toDateOnly(booking.checkin_date ?? booking.arrival_date);
  const checkOut = toDateOnly(booking.checkout_date ?? booking.departure_date);
  const guests = (booking.occupancy?.adults ?? 0) + (booking.occupancy?.children ?? 0);

  return {
    bookingId,
    revisionId,
    status,
    channexRoomTypeId,
    checkIn,
    checkOut,
    guests: guests > 0 ? guests : undefined,
    guestName: booking.customer?.name,
    guestEmail: booking.customer?.mail,
    guestPhone: booking.customer?.phone,
    amountCents: toCents(booking.amount_cents ?? booking.amount),
  };
}
