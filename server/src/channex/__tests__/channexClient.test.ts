/**
 * SPEC-modulo-12A-otas-fundaciones-mapeo.md § 4/§ 8 — the API key is a
 * secret with the exact same treatment as Asaas's: it must never surface in
 * a thrown error, a log line, or anything serialized back to a caller. These
 * tests mock `config.js` directly (rather than real env vars) so the "secret"
 * used here is an obviously-fake sentinel string we can grep for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'super-secret-channex-key-should-never-leak-anywhere';

const mockConfig: { channex: { env: 'staging' | 'production'; apiKey: string | undefined; baseUrl: string } } = {
  channex: { env: 'staging', apiKey: SECRET, baseUrl: 'https://staging.channex.test/api/v1' },
};

vi.mock('../../config.js', () => ({ config: mockConfig }));

// The real ChannexRateLimiter is covered by channexRateLimiter.test.ts on its
// own — channexClient.ts uses a module-level singleton (maxRequests: 10,
// windowMs: 60_000) shared across every test in this file, and letting it
// throttle for real here would mean a real 60s wait once enough
// getProperty/listRoomTypes calls pile up across these tests.
vi.mock('../channexRateLimiter.js', () => ({
  ChannexRateLimiter: class {
    async schedule<T>(task: () => Promise<T>): Promise<T> {
      return task();
    }
  },
}));

const { ChannexApiError, ChannexNotConfiguredError, getProperty, listRoomTypes } = await import('../channexClient.js');

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

beforeEach(() => {
  mockConfig.channex.apiKey = SECRET;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getProperty', () => {
  it('sends the API key only in the user-api-key header, against the configured base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: { id: 'prop-1', attributes: { title: 'Pousada Catavento' } } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const property = await getProperty('prop-1');

    expect(property).toEqual({ id: 'prop-1', title: 'Pousada Catavento' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://staging.channex.test/api/v1/properties/prop-1');
    expect(init.headers['user-api-key']).toBe(SECRET);
  });

  it('throws ChannexNotConfiguredError instead of calling fetch when the key is missing', async () => {
    mockConfig.channex.apiKey = undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getProperty('prop-1')).rejects.toBeInstanceOf(ChannexNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries once on 429 (respecting Retry-After), then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { errors: { code: 'http_too_many_requests' } }, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { id: 'prop-1', attributes: { title: 'Pousada Catavento' } } }));
    vi.stubGlobal('fetch', fetchMock);

    const property = await getProperty('prop-1');

    expect(property).toEqual({ id: 'prop-1', title: 'Pousada Catavento' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('raises ChannexApiError on a non-OK, non-429 response, with status+body only', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { errors: { code: 'unauthorized' } }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await getProperty('prop-1').catch((e) => e);

    expect(error).toBeInstanceOf(ChannexApiError);
    expect(error.status).toBe(401);
    expect(error.body).toEqual({ errors: { code: 'unauthorized' } });
  });

  it('never leaks the API key through a thrown ChannexApiError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { errors: { code: 'server_error' } }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await getProperty('prop-1').catch((e) => e);

    expect(error).toBeInstanceOf(ChannexApiError);
    expect(error.message).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(Object.keys(error)).not.toContain('headers');
  });
});

describe('listRoomTypes', () => {
  it('maps the JSON:API collection shape to a flat array', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: [
          { id: 'rt-1', attributes: { title: 'Casal', count_of_rooms: 6 } },
          { id: 'rt-2', attributes: { title: 'Triplo', count_of_rooms: 3 } },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const roomTypes = await listRoomTypes('prop-1');

    expect(roomTypes).toEqual([
      { id: 'rt-1', title: 'Casal', count_of_rooms: 6 },
      { id: 'rt-2', title: 'Triplo', count_of_rooms: 3 },
    ]);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://staging.channex.test/api/v1/room_types?filter[property_id]=prop-1');
  });
});
