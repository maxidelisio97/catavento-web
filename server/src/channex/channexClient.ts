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
  const response = await fetch(`${config.channex.baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'user-api-key': config.channex.apiKey as string,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

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
