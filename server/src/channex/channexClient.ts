import { config } from '../config.js';
import { ChannexRateLimiter } from './channexRateLimiter.js';

/**
 * Mirrors AsaasApiError (../asaasClient.ts): status + response body only.
 * Deliberately carries nothing about the request itself (no headers, no
 * `user-api-key`) — SPEC-modulo-12A § 4/§ 8: the secret must never surface in
 * a thrown error, a log, or an API response.
 */
export class ChannexApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`Channex API error (${status}): ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

/** Thrown when CHANNEX_API_KEY isn't set yet — see config.ts's comment on why that's allowed. */
export class ChannexNotConfiguredError extends Error {
  constructor() {
    super('Channex API key is not configured (CHANNEX_API_KEY missing).');
  }
}

// Channex's documented limits (docs.channex.io/api-v.1-documentation/rate-limits)
// target the ARI push endpoints 12B/12C will use (10 req/min per resource).
// 12A only reads Property/Room Types, but this client is shared by every M12
// entrega, so the default is deliberately conservative rather than tuned to
// reads alone. 12B/12C can construct their own ChannexRateLimiter instance if
// a distinct budget turns out to be needed per-endpoint.
const limiter = new ChannexRateLimiter({ maxRequests: 10, windowMs: 60_000 });

const MAX_RETRIES_ON_429 = 3;

// SPEC-modulo-12C's fire-and-forget push (pushAvailability.ts) tracks every
// in-flight call so its test suite can drain them between tests — found
// while wiring that up: without a bound here, a hung TCP connection to
// Channex (network partition, no server-side close) would leave `fetch`
// unresolved forever, keeping that tracked promise (and this request's
// closure) alive in a long-running server indefinitely. Bounding every
// request here closes it at the root, for every caller of this client, not
// just the push path — `getProperty`/`listRoomTypes`/pull/ack callers get
// the same guarantee "for free".
const REQUEST_TIMEOUT_MS = 15_000;

interface ChannexRequestOptions {
  method?: string;
  body?: unknown;
}

async function channexRequest<T>(path: string, options: ChannexRequestOptions = {}): Promise<T> {
  if (!config.channex.apiKey) {
    throw new ChannexNotConfiguredError();
  }

  return limiter.schedule(() => requestWithRetry<T>(path, options.method ?? 'GET', options.body, 0));
}

async function requestWithRetry<T>(path: string, method: string, body: unknown, attempt: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${config.channex.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'user-api-key': config.channex.apiKey as string,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 429 && attempt < MAX_RETRIES_ON_429) {
    const waitMs = parseRetryAfterMs(response.headers.get('retry-after')) ?? 2 ** attempt * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return requestWithRetry<T>(path, method, body, attempt + 1);
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ChannexApiError(response.status, data);
  }

  return data as T;
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

// Channex uses a JSON:API-shaped response — the fields we actually read are
// pulled up to the top level so callers don't need to know that shape.
interface ChannexJsonApiResource<Attributes> {
  id: string;
  attributes: Attributes;
}

interface ChannexJsonApiSingle<Attributes> {
  data: ChannexJsonApiResource<Attributes>;
}

interface ChannexJsonApiCollection<Attributes> {
  data: ChannexJsonApiResource<Attributes>[];
}

interface ChannexPropertyAttributes {
  title?: string;
  [key: string]: unknown;
}

interface ChannexRoomTypeAttributes {
  title: string;
  count_of_rooms: number;
  [key: string]: unknown;
}

export type ChannexProperty = { id: string } & ChannexPropertyAttributes;

export type ChannexRoomType = { id: string } & ChannexRoomTypeAttributes;

/** GET /properties/:id — read-only, used by test-connection (SPEC § 5). */
export async function getProperty(propertyId: string): Promise<ChannexProperty> {
  const result = await channexRequest<ChannexJsonApiSingle<ChannexPropertyAttributes>>(`/properties/${propertyId}`);
  return { id: result.data.id, ...result.data.attributes };
}

/** GET /room_types?filter[property_id]=... — read-only, used by the mapping screen (12A entrega 2). */
export async function listRoomTypes(propertyId: string): Promise<ChannexRoomType[]> {
  const result = await channexRequest<ChannexJsonApiCollection<ChannexRoomTypeAttributes>>(
    `/room_types?filter[property_id]=${propertyId}`,
  );
  return result.data.map((resource) => ({ id: resource.id, ...resource.attributes }));
}

/**
 * GET /booking_revisions/feed?filter[property_id]=... — SPEC-modulo-12B
 * § 1/§ 3.4. VERIFIED LIVE against staging.channex.io on 2026-09-08: each
 * item is a JSON:API resource `{ type, id, attributes: {...} }`, flattened
 * here to `{ id, ...attributes }` (same convention as `getProperty`/
 * `listRoomTypes` above) so `channexPayload.ts`'s parser has one flat shape
 * to read. The revision's own `id` IS what `ackBookingRevision` expects —
 * confirmed there is no separate `revision_id` attribute.
 *
 * This is the ONLY way this codebase fetches revision content — the
 * webhook (webhooksChannex.ts) doesn't fetch a single revision by id: the
 * real "booking" trigger payload carries no identifier to fetch by (see
 * that file's docstring), so it calls `pullBookingRevisions`, which calls
 * this same function, instead.
 */
export async function fetchBookingRevisionsFeed(propertyId: string): Promise<unknown[]> {
  const result = await channexRequest<ChannexJsonApiCollection<Record<string, unknown>>>(
    `/booking_revisions/feed?filter[property_id]=${propertyId}`,
  );
  return (result.data ?? []).map((resource) => ({ id: resource.id, ...resource.attributes }));
}

/**
 * POST /booking_revisions/:id/ack — SPEC-modulo-12B § 1: required after
 * processing a revision from the feed, or Channex keeps re-serving it and
 * eventually emails a "não confirmado" notice (§ 1, 30 min without ack).
 */
export async function ackBookingRevision(revisionId: string): Promise<void> {
  await channexRequest(`/booking_revisions/${revisionId}/ack`, { method: 'POST' });
}

/**
 * ARI push — SPEC-modulo-12C § 2/§ 3.1. VERIFIED against docs.channex.io/
 * api-v.1-documentation/ari.md (2026-09-08): Channex has NO combined ARI
 * endpoint — availability (targets `room_type_id`) and rates/restrictions
 * (targets `rate_plan_id`) are two separate POST endpoints, each accepting a
 * `values` array so many nights/room-types can go in ONE HTTP call (this is
 * what "agrupado" means in § 0.2 — one call with many `values` entries, not
 * one call per night).
 *
 * VERIFIED LIVE against staging.channex.io on 2026-09-09 (SPEC § 7's
 * mandatory pre-merge check): pushed via the real panel flow (resync
 * endpoint) against property f6a1bdf1-cef7-4e16-bc4e-a4799510d23f, room
 * type 7f1fe757-cf66-4878-82fe-ae25920e8d1f — `GET /availability` echoed
 * back the exact `disponibles` count pushed, and `GET /restrictions`
 * echoed `"rate": "220.00"` for a pushed value of `22000` (cents, integer)
 * — confirms the docs' field note ("integer (20000 for $200.00)") for real,
 * not just from reading the docs.
 */
export interface ChannexAvailabilityValue {
  propertyId: string;
  roomTypeId: string;
  /** 'YYYY-MM-DD'. */
  date: string;
  availability: number;
}

/** POST /availability — pushes a count of free units per night for a room type. */
export async function pushAvailability(values: ChannexAvailabilityValue[]): Promise<void> {
  if (values.length === 0) return;

  await channexRequest('/availability', {
    method: 'POST',
    body: {
      values: values.map((v) => ({
        property_id: v.propertyId,
        room_type_id: v.roomTypeId,
        date: v.date,
        availability: v.availability,
      })),
    },
  });
}

export interface ChannexRestrictionValue {
  propertyId: string;
  ratePlanId: string;
  /** 'YYYY-MM-DD'. */
  date: string;
  /**
   * Multi-occupancy rates for this rate plan/night (docs' "Multi Occupancy
   * Example"). `rate` is cents as an INTEGER — docs.channex.io/api-v.1-
   * documentation/ari.md's own field note confirms the integer form is
   * minor units ("integer (20000 for $200.00)"), matching this codebase's
   * "dinero: centavos como INTEGER" convention with zero conversion needed.
   */
  rates?: { occupancy: number; rate: number }[];
  minStay?: number;
  /** Full stop-sell — the closest match to this codebase's local `closed` (SPEC § 3.1). */
  stopSell?: boolean;
}

/** POST /restrictions — pushes per-occupancy rate + min_stay + stop_sell for a rate plan/night. */
export async function pushRestrictions(values: ChannexRestrictionValue[]): Promise<void> {
  if (values.length === 0) return;

  await channexRequest('/restrictions', {
    method: 'POST',
    body: {
      values: values.map((v) => ({
        property_id: v.propertyId,
        rate_plan_id: v.ratePlanId,
        date: v.date,
        ...(v.rates ? { rates: v.rates } : {}),
        ...(v.minStay !== undefined ? { min_stay: v.minStay } : {}),
        ...(v.stopSell !== undefined ? { stop_sell: v.stopSell } : {}),
      })),
    },
  });
}
