import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { requestJson, requestUrl } from '../test/fetchStub';
import { AssetDetailPage } from './AssetDetailPage';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  location.hash = '';
});

function detail(overrides: Record<string, unknown> = {}) {
  return {
    assetId: 'MY_CHAIR',
    name: 'My Chair',
    category: 'chairs',
    source: 'custom',
    author: { discordId: null, username: 'someone', displayName: 'someone', avatarUrl: null },
    tags: ['static'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    files: { sprite: '/api/v1/assets/MY_CHAIR/sprite.png' },
    manifest: [{ id: 'MY_CHAIR' }],
    ...overrides,
  };
}

function authUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    discordId: 'user-1',
    username: 'someone-else',
    displayName: 'someone-else',
    avatarUrl: null,
    role: 'user',
    capabilityCheckedAt: null,
    capabilityCacheTtlMs: 60_000,
    submission: { allowed: true, reason: null, inviteUrl: null },
    ...overrides,
  };
}

const AUTH_RESPONSE = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresInMs: 900_000,
  user: authUser(),
};

/**
 * Logs the caller in through the same login-code hash `AuthProvider` reads on
 * mount — same convention `MyLayoutsPage.test.tsx` establishes for exercising
 * an authenticated route without a real Discord round trip.
 */
function loginAs(user: Record<string, unknown>) {
  location.hash = '#pixelIndexLoginCode=test-code';
  return { ...AUTH_RESPONSE, user };
}

function stubFetch(assetBody: unknown, authResponse: unknown = AUTH_RESPONSE) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.includes('/auth/token')) return Response.json(authResponse);
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json(assetBody);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/assets/MY_CHAIR']}>
      <AuthProvider>
        <Routes>
          <Route path="assets/:id" element={<AssetDetailPage />} />
          <Route path="assets" element={<p>Gallery</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AssetDetailPage', () => {
  it('renders the asset, its author, and a single-asset "Open in editor" link (#121)', async () => {
    stubFetch(detail());
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'My Chair' })).toBeInTheDocument();
    expect(screen.getByText('by someone', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in editor' })).toHaveAttribute(
      'href',
      '/editor?asset=MY_CHAIR',
    );
    expect(screen.getByText('MY_CHAIR')).toBeInTheDocument();
    expect(screen.getByText('chairs')).toBeInTheDocument();
  });

  it('links to the single-asset editor for a builtin asset too (#121 symmetry with #119)', async () => {
    stubFetch(detail({ source: 'builtin' }));
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'My Chair' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in editor' })).toHaveAttribute(
      'href',
      '/editor?asset=MY_CHAIR',
    );
  });

  it('shows a "Built-in" notice instead of an author link for a builtin asset', async () => {
    stubFetch(detail({ source: 'builtin' }));
    renderDetail();

    expect(await screen.findByText('Built-in — bundled with Pixel Agents', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('by someone', { exact: false })).not.toBeInTheDocument();
  });

  it('shows a Download link for a custom asset, pointing at the download endpoint', async () => {
    stubFetch(detail());
    renderDetail();

    expect(await screen.findByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      expect.stringContaining('/api/v1/assets/MY_CHAIR/download'),
    );
  });

  it('shows no Download link for a builtin asset (#119: redundant with vendor/pixel-agents)', async () => {
    stubFetch(detail({ source: 'builtin' }));
    renderDetail();

    await screen.findByRole('heading', { name: 'My Chair' });
    expect(screen.queryByRole('link', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('shows an error notice for a 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'not_found', message: 'No custom asset "MY_CHAIR".' }, { status: 404 })),
    );
    renderDetail();
    expect(await screen.findByText('No custom asset "MY_CHAIR".')).toBeInTheDocument();
  });

  describe('deletion (#125)', () => {
    it('shows no Delete button for an anonymous visitor', async () => {
      stubFetch(detail());
      renderDetail();
      await screen.findByRole('heading', { name: 'My Chair' });
      expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    });

    it('shows no Delete button for a logged-in stranger — neither the owner nor a moderator', async () => {
      const auth = loginAs(authUser({ id: 'stranger', discordId: 'stranger', role: 'user' }));
      stubFetch(detail({ author: { discordId: 'owner-1', username: 'owner', displayName: 'owner', avatarUrl: null } }), auth);
      renderDetail();
      await screen.findByRole('heading', { name: 'My Chair' });
      expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    });

    it("shows a Delete button for the asset's own author", async () => {
      const auth = loginAs(authUser({ id: 'owner-1', discordId: 'owner-1', role: 'user' }));
      stubFetch(detail({ author: { discordId: 'owner-1', username: 'owner', displayName: 'owner', avatarUrl: null } }), auth);
      renderDetail();
      expect(await screen.findByRole('button', { name: 'Delete' })).toBeInTheDocument();
    });

    it("shows a Delete button for a moderator on someone else's asset", async () => {
      const auth = loginAs(authUser({ id: 'mod-1', discordId: 'mod-1', role: 'moderator' }));
      stubFetch(detail({ author: { discordId: 'owner-1', username: 'owner', displayName: 'owner', avatarUrl: null } }), auth);
      renderDetail();
      expect(await screen.findByRole('button', { name: 'Delete' })).toBeInTheDocument();
    });

    it('shows no Delete button for a builtin asset, even for a moderator', async () => {
      const auth = loginAs(authUser({ id: 'mod-1', discordId: 'mod-1', role: 'moderator' }));
      stubFetch(detail({ source: 'builtin' }), auth);
      renderDetail();
      await screen.findByRole('heading', { name: 'My Chair' });
      expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    });

    it('deletes without prompting for a reason when the owner deletes their own asset, then navigates to the gallery', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const promptSpy = vi.spyOn(window, 'prompt');
      const auth = loginAs(authUser({ id: 'owner-1', discordId: 'owner-1', role: 'user' }));
      const fetchMock = stubFetch(
        detail({ author: { discordId: 'owner-1', username: 'owner', displayName: 'owner', avatarUrl: null } }),
        auth,
      );
      renderDetail();
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(screen.getByText('Gallery')).toBeInTheDocument());
      expect(promptSpy).not.toHaveBeenCalled();
      const deleteCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
      expect(deleteCall?.[0]).toContain('/api/v1/assets/MY_CHAIR');
      expect(deleteCall?.[1]?.body).toBeUndefined();
    });

    it("prompts for and sends a reason when a moderator deletes someone else's asset", async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      vi.spyOn(window, 'prompt').mockReturnValue('policy violation');
      const auth = loginAs(authUser({ id: 'mod-1', discordId: 'mod-1', role: 'moderator' }));
      const fetchMock = stubFetch(
        detail({ author: { discordId: 'owner-1', username: 'owner', displayName: 'owner', avatarUrl: null } }),
        auth,
      );
      renderDetail();
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(screen.getByText('Gallery')).toBeInTheDocument());
      const deleteCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
      expect(requestJson<{ reason: string }>(deleteCall?.[1]).reason).toBe('policy violation');
    });

    it('does nothing if the moderator cancels the reason prompt', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      vi.spyOn(window, 'prompt').mockReturnValue(null);
      const auth = loginAs(authUser({ id: 'mod-1', discordId: 'mod-1', role: 'moderator' }));
      const fetchMock = stubFetch(
        detail({ author: { discordId: 'owner-1', username: 'owner', displayName: 'owner', avatarUrl: null } }),
        auth,
      );
      renderDetail();
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

      await screen.findByRole('heading', { name: 'My Chair' });
      const deleteCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
      expect(deleteCall).toBeUndefined();
    });

    it('does nothing if the confirm dialog is dismissed', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      const auth = loginAs(authUser({ id: 'owner-1', discordId: 'owner-1', role: 'user' }));
      const fetchMock = stubFetch(
        detail({ author: { discordId: 'owner-1', username: 'owner', displayName: 'owner', avatarUrl: null } }),
        auth,
      );
      renderDetail();
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

      await screen.findByRole('heading', { name: 'My Chair' });
      const deleteCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
      expect(deleteCall).toBeUndefined();
    });
  });
});
