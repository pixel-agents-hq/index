import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, authorAvatarSrc, getLayoutJson, listLayouts } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('listLayouts', () => {
  it('returns the parsed response on success', async () => {
    const body = { schemaVersion: 1, total: 0, layouts: [], nextCursor: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
    await expect(listLayouts()).resolves.toEqual(body);
  });

  it('normalizes a non-2xx response into an ApiError carrying the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );
    await expect(listLayouts()).rejects.toMatchObject({ status: 500 });
  });

  it('normalizes a network failure into an ApiError, not a raw TypeError', async () => {
    // The shape every unreachable-API code path (#12's "degrades legibly"
    // criterion) actually renders from — fetch throws a bare TypeError on a
    // network failure, not something with a status or a friendly message.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(listLayouts()).rejects.toBeInstanceOf(ApiError);
  });
});

/**
 * A fetch that never answers, and rejects the way a real one does when its
 * signal fires. The global fetch is always stubbed in these suites, so this is
 * the only honest way to exercise abort semantics.
 */
function stallingFetch() {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }),
  );
}

/** The rejection reason, without asserting anything about it yet. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe('cancellation', () => {
  it('rejects an aborted request with the abort, never with an ApiError', async () => {
    // The whole reason apiRequest inspects the signal: its catch-all used to
    // turn every fetch rejection into "Could not reach the API", which would
    // put a network-failure banner in front of a user whose network is fine,
    // raised by the very effect that cancelled the request.
    vi.stubGlobal('fetch', stallingFetch());
    const controller = new AbortController();

    const pending = rejectionOf(listLayouts({}, controller.signal));
    controller.abort();

    const error = await pending;
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });

  it('forwards the signal to fetch', async () => {
    // The parameters are declared even though the body ignores them: without
    // them the mock's call tuple is empty and `calls[0][1]` does not typecheck.
    // This is the test that fails when an eleventh read wrapper is added and
    // the signal is not passed through.
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();

    await listLayouts({}, controller.signal);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });

  it('never sends a request for a signal that has already aborted', async () => {
    // StrictMode mounts, cleans up and remounts every effect, so without the
    // throwIfAborted() guard the first mount's request is sent purely to be
    // cancelled a tick later.
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort();

    expect(await rejectionOf(listLayouts({}, controller.signal))).toMatchObject({
      name: 'AbortError',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still normalizes a network failure when a signal is present but not aborted', async () => {
    // The regression guard for the branch above: a future refactor that keyed
    // on the error's shape rather than on our own signal would pass every other
    // test in this block and quietly stop reporting real outages.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const controller = new AbortController();
    await expect(listLayouts({}, controller.signal)).rejects.toBeInstanceOf(ApiError);
  });

  it('does not surface an abort during the error-body read as an ApiError', async () => {
    // The second place an abort could be laundered: a non-2xx response whose
    // body read is what gets cancelled. `as unknown as Response` because jsdom
    // cannot build a Response whose body stalls; apiRequest touches only `ok`,
    // `status` and `json()` on this path.
    const controller = new AbortController();
    const stalledBody = {
      ok: false,
      status: 500,
      json: () =>
        new Promise((_resolve, reject) => {
          const fail = () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          };
          // Both orderings: the abort can land before apiRequest gets as far as
          // reading the body, or while it is waiting.
          if (controller.signal.aborted) fail();
          else controller.signal.addEventListener('abort', fail);
        }),
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn(async () => stalledBody));

    const pending = rejectionOf(listLayouts({}, controller.signal));
    controller.abort();

    const error = await pending;
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });
});

describe('getLayoutJson', () => {
  it('returns the exact download text without parsing it', async () => {
    const source = '{"version":1,"spacing":"is preserved"}\n';
    const fetch = vi.fn(async () => new Response(source, { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await expect(getLayoutJson('office / one')).resolves.toBe(source);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/layouts\/office%20%2F%20one\/download$/),
      expect.any(Object),
    );
  });
});

describe('authorAvatarSrc (#133)', () => {
  it('prefers the avatar an author has', () => {
    expect(authorAvatarSrc({ avatarUrl: 'https://cdn.example/a.png', avatarSeed: 'px.AAAA' })).toBe('https://cdn.example/a.png');
  });

  it('falls back to the API-drawn default from the stored seed code', () => {
    expect(authorAvatarSrc({ avatarUrl: null, avatarSeed: 'px.AB-_c' })).toMatch(/\/api\/v1\/avatars\/px\.AB-_c\.png$/);
  });

  it('is null with neither, as from a legacy credit or an API older than the seed', () => {
    expect(authorAvatarSrc({ avatarUrl: null, avatarSeed: null })).toBeNull();
    expect(authorAvatarSrc({ avatarUrl: null })).toBeNull();
  });
});
