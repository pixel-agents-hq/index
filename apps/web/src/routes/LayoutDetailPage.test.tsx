import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { requestUrl } from '../test/fetchStub';
import { LayoutDetailPage } from './LayoutDetailPage';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  location.hash = '';
});

function detail(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'blue-office',
    title: 'Blue Office',
    author: { discordId: null, username: 'someone', displayName: 'someone', avatarUrl: null },
    description: 'A cosy office.',
    tags: ['cosy', 'small'],
    cols: 25,
    rows: 22,
    visibleCols: 25,
    visibleRows: 22,
    furniture: 59,
    areas: 4,
    pets: 2,
    carpets: 0,
    seats: 3,
    layoutRevision: 1,
    pixelAgentsVersion: '1.4.0',
    bytes: 10,
    sha256: 'a'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    files: { layout: '/api/v1/layouts/blue-office/download', preview: '', thumbnail: '' },
    layout: {},
    ...overrides,
  };
}

function meta(layoutRevision = 1) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    pixelAgents: { version: '1.4.0', commit: null, layoutRevision },
    count: 1,
  };
}

function stubFetch(layoutBody: unknown, metaBody: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes('/meta')) return Response.json(metaBody);
      if (url.endsWith('/download')) {
        return new Response('{"version":1,"layoutRevision":1,"cols":2,"rows":2,"tiles":[0,0,0,0],"furniture":[]}');
      }
      return Response.json(layoutBody);
    }),
  );
}

/**
 * Wrapped in a real `AuthProvider` with no login code in the URL, which is the
 * anonymous case: this page is public, and the editor links (#65) it grew are
 * the only thing on it that depends on who is looking.
 */
function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/layouts/blue-office']}>
      <AuthProvider>
        <Routes>
          <Route path="layouts/:slug" element={<LayoutDetailPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LayoutDetailPage', () => {
  it('renders full metadata: facts, tags, sha256, dates, download link', async () => {
    stubFetch(detail(), meta());
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'Blue Office' })).toBeInTheDocument();
    expect(screen.getByText('25×22')).toBeInTheDocument();
    expect(screen.getByText('cosy')).toBeInTheDocument();
    expect(screen.getByText('small')).toBeInTheDocument();
    expect(screen.getByText('a'.repeat(64))).toBeInTheDocument();

    const download = screen.getByRole('link', { name: 'Download layout.json' });
    expect(download).toHaveAttribute('href', 'http://localhost:3000/api/v1/layouts/blue-office/download');
    expect(download).toHaveAttribute('download', 'blue-office.json');
  });

  it('shows no revision warning when the layout matches the current pin', async () => {
    stubFetch(detail({ layoutRevision: 3 }), meta(3));
    renderDetail();
    await screen.findByRole('heading', { name: 'Blue Office' });
    expect(screen.queryByText(/may not import cleanly/)).not.toBeInTheDocument();
  });

  it("warns when the layout's revision is ahead of the site's current pin", async () => {
    stubFetch(detail({ layoutRevision: 5 }), meta(3));
    renderDetail();
    expect(await screen.findByText('This layout may not import cleanly.')).toBeInTheDocument();
    expect(screen.getByText(/revision 5/)).toBeInTheDocument();
    expect(screen.getByText(/revision 3/)).toBeInTheDocument();
  });

  it('shows a message, not a blank page, when the layout itself is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    renderDetail();
    expect(await screen.findByText(/Could not reach the API/)).toBeInTheDocument();
  });

  it('lets an authenticated user trigger a share and reports queued subscribers', async () => {
    location.hash = '#pixelIndexLoginCode=test-code';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes('/auth/token')) {
          return Response.json({
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresInMs: 900_000,
            user: {
              id: 'user-1',
              discordId: '1528094749993599038',
              username: 'sharer',
              displayName: 'Sharer',
              avatarUrl: null,
              role: 'user',
              capabilityCheckedAt: null,
              capabilityCacheTtlMs: 60000,
              submission: { allowed: true, reason: null, inviteUrl: null },
            },
          });
        }
        if (url.endsWith('/api/v1/layouts/share') && init?.method === 'POST') {
          return Response.json({
            eventId: 'a75fc4d8-d0f7-4b26-9c6d-3329f9fc2834',
            occurredAt: '2026-08-15T12:34:56.000Z',
            deliveriesQueued: 2,
          }, { status: 202 });
        }
        if (url.includes('/meta')) return Response.json(meta());
        if (url.endsWith('/download')) return new Response(JSON.stringify(detail().layout));
        return Response.json(detail());
      }),
    );
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
    expect(await screen.findByText('Shared with 2 subscribed services.')).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) =>
      requestUrl(input).endsWith('/api/v1/layouts/share') && init?.method === 'POST',
    )).toBe(true);
  });
});
