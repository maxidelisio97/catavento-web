/**
 * Maps a Channex Booking Revision resource (already flattened from its
 * JSON:API `{data: {id, attributes}}`/`{data: [{id, attributes}]}` shape by
 * `channexClient.ts`'s `getBookingRevision`/`fetchBookingRevisionsFeed`)
 * into `ChannexBookingRevisionInput` (processBookingRevision.ts).
 *
 * VERIFIED LIVE against staging.channex.io on 2026-09-08: a real test
 * booking was created via Channex's own "Booking CRS" app on the staging
 * property (f6a1bdf1-cef7-4e16-bc4e-a4799510d23f), then fetched for real
 * through GET /booking_revisions/feed AND GET /booking_revisions/:id, run
 * through this exact parser and `processBookingRevision` end-to-end against
 * catavento_db_test, and acked back to Channex for real. The reservation it
 * produced matched the source booking field-for-field (guest name built
 * from customer.name + customer.surname, dates, guest count, amount in
 * cents). No field-name adjustments were needed — the shape below (already
 * confirmed once against the published docs on 2026-09-07) held exactly.
 *
 * ```json
 * {
 *   "type": "booking_revision",
 *   "id": "03dd7198-...",              // THIS is the revision id — there is
 *   "attributes": {                     // no separate "revision_id" field.
 *     "booking_id": "cfa33f3b-...",
 *     "status": "new",                  // "new" | "modified" | "cancelled"
 *     "rooms": [{ "room_type_id": "...", "checkin_date": "...", "checkout_date": "...", "amount": "200.00", "occupancy": {...} }],
 *     "customer": { "name": "User", "surname": "Channex", "mail": "...", "phone": "..." },
 *     "occupancy": { "adults": 2, "children": 0, "infants": 0 },
 *     "arrival_date": "2019-04-26",     // booking-level dates — NOT "checkin_date"
 *     "departure_date": "2019-04-27",   // ("checkin_date"/"checkout_date" only exist per-room)
 *     "amount": "220.00",               // total for the stay, as a decimal STRING
 *     "currency": "GBP"
 *   }
 * }
 * ```
 *
 * The webhook itself does NOT carry any of this — Channex's docs are
 * explicit that `booking_new`/`booking_modification`/`booking_cancellation`
 * webhook deliveries only carry `{event, payload: {booking_id, revision_id}}`
 * and exist "to trigger a Pull booking revision operation from the PMS":
 * the PMS is expected to call `GET /booking_revisions/:id` with that
 * `revision_id` to fetch the shape above. `webhooksChannex.ts` does that
 * fetch before ever calling this parser — this file only ever sees the full
 * revision resource, from either that fetch or a feed item, never the raw
 * webhook envelope.
 */
import type { ChannexBookingRevisionInput } from './processBookingRevision.js';

/** The flattened shape channexClient.ts produces: `{ id: <resource id>, ...attributes }`. */
export interface FlatChannexBookingRevision {
  id?: string;
  booking_id?: string;
  status?: string;
  rooms?: { room_type_id?: string }[];
  customer?: { name?: string; surname?: string; mail?: string; phone?: string };
  occupancy?: { adults?: number; children?: number; infants?: number };
  arrival_date?: string;
  departure_date?: string;
  /** Total for the stay, as Channex reports it — a decimal string (e.g. "220.00"), per the docs example. */
  amount?: number | string;
  [key: string]: unknown;
}

const STATUS_MAP: Record<string, ChannexBookingRevisionInput['status']> = {
  new: 'new',
  modified: 'modified',
  cancelled: 'cancelled',
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
  // Confirmed decimal-string convention (docs example: "220.00") — same
  // conversion the rest of this codebase uses (server/CLAUDE.md: "Dinero:
  // centavos como INTEGER").
  return Math.round(asNumber * 100);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Returns `null` for anything that isn't a processable revision: missing
 * required fields, or a shape this parser doesn't recognize at all.
 *
 * Wraps the actual parsing in a try/catch and never lets a
 * malformed/unexpected-type field throw out to the caller — both the
 * webhook (never a non-200 to Channex over a body-shape surprise) and the
 * pull (one bad feed item must not abort the rest of the batch) depend on
 * this function never throwing.
 */
export function parseChannexBookingRevision(raw: unknown): ChannexBookingRevisionInput | null {
  try {
    return parseChannexBookingRevisionUnsafe(raw);
  } catch {
    return null;
  }
}

function parseChannexBookingRevisionUnsafe(raw: unknown): ChannexBookingRevisionInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const flat = raw as FlatChannexBookingRevision;

  // The revision id IS the resource's own `id` — confirmed there is no
  // separate `revision_id` attribute (see this file's docstring example).
  const revisionId = flat.id;
  const bookingId = flat.booking_id;
  const rawStatus = flat.status;

  if (!isNonEmptyString(bookingId) || !isNonEmptyString(revisionId) || !isNonEmptyString(rawStatus)) return null;

  const status = STATUS_MAP[rawStatus.toLowerCase()];
  if (!status) return null;

  if (status === 'cancelled') {
    return { bookingId, revisionId, status };
  }

  const rooms = Array.isArray(flat.rooms) ? flat.rooms : [];
  if (rooms.length > 1) {
    return { bookingId, revisionId, status, multiRoom: true };
  }

  const room = rooms[0];
  const channexRoomTypeId = room?.room_type_id;
  // Booking-level dates — confirmed field names are arrival_date/departure_date,
  // NOT checkin_date/checkout_date (those only exist per-room in `rooms[]`).
  const checkIn = toDateOnly(flat.arrival_date);
  const checkOut = toDateOnly(flat.departure_date);
  const guests = (flat.occupancy?.adults ?? 0) + (flat.occupancy?.children ?? 0);

  // Confirmed: customer.name and customer.surname are separate fields.
  const guestName = [flat.customer?.name, flat.customer?.surname].filter(isNonEmptyString).join(' ') || undefined;

  return {
    bookingId,
    revisionId,
    status,
    channexRoomTypeId,
    checkIn,
    checkOut,
    guests: guests > 0 ? guests : undefined,
    guestName,
    guestEmail: flat.customer?.mail,
    guestPhone: flat.customer?.phone,
    amountCents: toCents(flat.amount),
  };
}
