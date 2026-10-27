import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { requestUrl } from '../test/fetchStub';
import { ThemeProvider } from '../theme/ThemeProvider';
import { Layout } from './Layout';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  location.hash = '';
});

function metaBody(discordInviteUrl: string | null) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    pixelAgents: { version: null, commit: null, layoutRevision: 0 },
    count: 0,
    discordInviteUrl,
  };
}

function stubFetch(discordInviteUrl: string | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes('/meta')) return Response.json(metaBody(discordInviteUrl));
      return new Response('{}', { status: 200 });
    }),
  );
}

/** Drives AuthProvider through a real login-code exchange, as the other auth tests do. */
function stubLoggedIn(overrides: Record<string, unknown> = {}) {
  location.hash = '#pixelIndexLoginCode=test-code';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes('/meta')) return Response.json(metaBody(null));
      return Response.json({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresInMs: 900_000,
        user: {
          id: 'internal-uuid-1',
          discordId: '900000000000000001',
          username: 'someone',
          displayName: 'Someone',
          avatarUrl: null,
          role: 'user',
          capabilityCheckedAt: null,
          capabilityCacheTtlMs: 60000,
          submission: { allowed: true, reason: null, inviteUrl: null },
          ...overrides,
        },
      });
    }),
  );
}

function renderLayout() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <AuthProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<p>page content</p>} />
            </Route>
          </Routes>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('Layout header nav', () => {
  it('links "Create" to the editor, not the raw submit form (#85)', async () => {
    stubFetch(null);
    renderLayout();
    const create = await screen.findByRole('link', { name: 'Create' });
    expect(create).toHaveAttribute('href', '/editor');
  });

  it('shows the Discord invite to a logged-out visitor — joining is not gated behind authentication', async () => {
    stubFetch('https://discord.gg/pixel-index');
    renderLayout();
    const invite = await screen.findByRole('link', { name: 'Discord' });
    expect(invite).toHaveAttribute('href', 'https://discord.gg/pixel-index');
  });

  it('renders no Discord link when no guild invite is configured', async () => {
    stubFetch(null);
    renderLayout();
    await screen.findByText('page content');
    expect(screen.queryByRole('link', { name: 'Discord' })).not.toBeInTheDocument();
  });

  it('keeps the invite link named "Discord" now that its only content is the logo (#66)', async () => {
    stubFetch('https://discord.gg/pixel-index');
    renderLayout();
    const invite = await screen.findByRole('link', { name: 'Discord' });
    // The mark itself is decorative; the link carries the accessible name.
    const logo = invite.querySelector('svg');
    expect(logo).toHaveAttribute('aria-hidden', 'true');
    expect(invite).not.toHaveTextContent('Discord');
  });

  it('names the emoji-only log-in control for assistive tech (#66)', async () => {
    stubFetch(null);
    renderLayout();
    const login = await screen.findByRole('button', { name: 'Log in with Discord' });
    expect(login).toHaveTextContent('🔒');
  });
});

describe('Layout upstream pin', () => {
  it('names the pinned Pixel Agents version and links the upstream tree at that exact commit', async () => {
    // vitest.config.ts defines the build-time pin as 9.9.9 at 000…0 on git.example.test/pixel-agents.
    stubFetch(null);
    renderLayout();
    const pin = await screen.findByRole('link', { name: 'Pixel Agents v9.9.9' });
    expect(pin).toHaveAttribute(
      'href',
      `https://git.example.test/pixel-agents/tree/${'0'.repeat(40)}`,
    );
    expect(pin).toHaveAttribute('title', `Pinned to ${'0'.repeat(40)}`);
  });
});

describe('Layout account menu', () => {
  it('links to the caller\'s own public profile by Discord id, not internal id', async () => {
    stubLoggedIn();
    renderLayout();
    const profile = await screen.findByRole('link', { name: 'Visit profile' });
    expect(profile).toHaveAttribute('href', '/authors/900000000000000001');
  });

  it('opens from the avatar and logs out from within the menu', async () => {
    stubLoggedIn({ avatarUrl: 'https://cdn.discordapp.com/avatars/1/hash.png' });
    renderLayout();
    const trigger = await screen.findByLabelText('Account menu for Someone');
    expect(trigger.querySelector('img')).toHaveAttribute(
      'src',
      'https://cdn.discordapp.com/avatars/1/hash.png',
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('button', { name: 'Log in with Discord' })).toBeInTheDocument();
  });

  it('omits the profile link for an account with no Discord id', async () => {
    stubLoggedIn({ discordId: null });
    renderLayout();
    await screen.findByRole('button', { name: 'Log out' });
    expect(screen.queryByRole('link', { name: 'Visit profile' })).not.toBeInTheDocument();
  });
});
