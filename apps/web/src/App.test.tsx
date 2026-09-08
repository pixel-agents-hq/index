import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { AuthProvider } from './auth/AuthProvider';
import { requestUrl } from './test/fetchStub';
import { ThemeProvider } from './theme/ThemeProvider';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

// Not a test of the GitHub Pages 404.html trick itself (that's a build-time
// file plus browser-only sessionStorage behavior, not unit-testable) — this
// proves the router config it depends on actually resolves a deep route,
// the way index.html's restore script hands the real path back to it.
describe('App routing', () => {
  it('resolves a deep link directly, without visiting / first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes('/meta')) {
          return Response.json({
            schemaVersion: 1,
            generatedAt: '2026-01-01T00:00:00.000Z',
            pixelAgents: { version: '1.4.0', commit: null, layoutRevision: 1 },
            count: 1,
          });
        }
        return Response.json({
          slug: 'blue-office',
          title: 'Blue Office',
          author: { discordId: null, username: 'someone', displayName: 'someone', avatarUrl: null },
          description: '',
          tags: [],
          cols: 4,
          rows: 4,
          visibleCols: 4,
          visibleRows: 4,
          furniture: 0,
          areas: 0,
          pets: 0,
          carpets: 0,
          seats: 3,
          layoutRevision: 1,
          pixelAgentsVersion: '1.4.0',
          bytes: 10,
          sha256: 'a'.repeat(64),
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          files: { layout: '', preview: '', thumbnail: '' },
          layout: {},
        });
      }),
    );
    render(
      <MemoryRouter initialEntries={['/layouts/blue-office']}>
        <ThemeProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Blue Office' })).toBeInTheDocument();
  });

  it('redirects the root route to /layouts/ (#101)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes('/api/v1/tags')) return Response.json({ schemaVersion: 1, tags: [] });
        if (url.includes('/api/v1/meta')) {
          return Response.json({
            schemaVersion: 1,
            generatedAt: '2026-01-01T00:00:00.000Z',
            apiCommit: null,
            pixelAgents: { version: null, commit: null, layoutRevision: 0 },
            count: 0,
            discordInviteUrl: null,
          });
        }
        return Response.json({ schemaVersion: 1, total: 0, layouts: [], nextCursor: null });
      }),
    );
    render(
      <MemoryRouter initialEntries={['/']}>
        <ThemeProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('No layouts published yet.')).toBeInTheDocument();
  });

  it('renders NotFound for an unmatched route', () => {
    render(
      <MemoryRouter initialEntries={['/does-not-exist']}>
        <ThemeProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Not found' })).toBeInTheDocument();
  });
});
