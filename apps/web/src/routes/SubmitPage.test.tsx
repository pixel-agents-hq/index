import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { requestUrl } from '../test/fetchStub';
import { SubmitPage } from './SubmitPage';

beforeEach(() => {
  location.hash = '#pixelIndexLoginCode=test-code';
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  location.hash = '';
});

const AUTH_RESPONSE = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresInMs: 900_000,
  user: { id: '1', username: 'someone', displayName: 'someone', avatarUrl: null, role: 'user', capabilityCheckedAt: null, capabilityCacheTtlMs: 60000, submission: { allowed: true, reason: null, inviteUrl: null } },
};

// The invite is public — sourced from /meta, not from the (auth-gated) /me
// response — so every test that doesn't care about it defaults to "unset"
// rather than accidentally asserting on a stale per-user value.
const META_RESPONSE = {
  schemaVersion: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  pixelAgents: { version: null, commit: null, layoutRevision: 0 },
  count: 0,
  discordInviteUrl: null as string | null,
};

// Backs the content-policy link's repository/commit pin (see client.ts's
// repoFileUrl) — every test gets a real link, not `undefined`, without
// having to know that's why `/` is being requested.
const ROOT_RESPONSE = {
  name: 'Pixel Index API',
  description: 'Third-party integration is encouraged.',
  version: '1',
  commit: 'a'.repeat(40),
  documentation: 'http://localhost:3000/docs',
  openapi: 'http://localhost:3000/openapi.json',
  repository: 'https://github.com/pixel-agents-hq/index',
};

function stubFetch(
  handleOther: (url: string, init?: RequestInit) => Response,
  authResponse: unknown = AUTH_RESPONSE,
  metaResponse: unknown = META_RESPONSE,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes('/auth/token')) return Response.json(authResponse);
      if (url.includes('/meta')) return Response.json(metaResponse);
      if (new URL(url).pathname === '/') return Response.json(ROOT_RESPONSE);
      return handleOther(url, init);
    }),
  );
}

function renderSubmit(state?: { raw: string }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/', ...(state ? { state } : {}) }]}>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<SubmitPage />} />
          <Route path="/layouts/:slug" element={<p>landed on detail page</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function waitForAuthReady() {
  // SubmitPage renders immediately; wait for the auth exchange (triggered
  // by the login-code hash) to land before interacting with it.
  await screen.findByRole('button', { name: 'Check preview' });
}

const VALID_LAYOUT = JSON.stringify({ version: 1, layoutRevision: 1, cols: 2, rows: 2, tiles: [0, 0, 0, 0], furniture: [] });

describe('SubmitPage', () => {
  it('shows the official invite instead of the form for a nonmember', async () => {
    stubFetch(
      () => new Response('{}', { status: 200 }),
      {
        ...AUTH_RESPONSE,
        user: {
          ...AUTH_RESPONSE.user,
          submission: { allowed: false, reason: 'discord_membership_required' as const, inviteUrl: null },
        },
      },
      { ...META_RESPONSE, discordInviteUrl: 'https://discord.gg/pixel-index' },
    );
    renderSubmit();
    const invite = await screen.findByRole('link', { name: 'Join the Discord server' });
    expect(invite).toHaveAttribute('href', 'https://discord.gg/pixel-index');
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
  });

  it('prompts a logged-out visitor with the same restriction message as a nonmember', async () => {
    location.hash = '';
    stubFetch(
      () => new Response('{}', { status: 200 }),
      AUTH_RESPONSE,
      { ...META_RESPONSE, discordInviteUrl: 'https://discord.gg/pixel-index' },
    );
    renderSubmit();
    expect(
      await screen.findByText(
        'Layout submission is available to members of the official Discord community. Log in with Discord to check your membership.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in with Discord' })).toBeInTheDocument();
    // The invite is public — a logged-out visitor sees it too, not just a nonmember.
    const invite = await screen.findByRole('link', { name: 'Join the Discord server' });
    expect(invite).toHaveAttribute('href', 'https://discord.gg/pixel-index');
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
  });

  it('offers Discord reconnection when the retained grant is unavailable, alongside the public invite', async () => {
    stubFetch(
      () => new Response('{}', { status: 200 }),
      {
        ...AUTH_RESPONSE,
        user: {
          ...AUTH_RESPONSE.user,
          submission: { allowed: false, reason: 'discord_reauthorization_required' as const, inviteUrl: null },
        },
      },
      { ...META_RESPONSE, discordInviteUrl: 'https://discord.gg/pixel-index' },
    );
    renderSubmit();
    expect(await screen.findByRole('button', { name: 'Reconnect Discord' })).toBeInTheDocument();
    const invite = await screen.findByRole('link', { name: 'Join the Discord server' });
    expect(invite).toHaveAttribute('href', 'https://discord.gg/pixel-index');
  });

  it('links the content policy before publishing (#11)', async () => {
    stubFetch(() => new Response('{}', { status: 200 }));
    renderSubmit();
    await waitForAuthReady();
    const link = await screen.findByRole('link', { name: 'content policy' });
    expect(link).toHaveAttribute(
      'href',
      `${ROOT_RESPONSE.repository}/blob/${ROOT_RESPONSE.commit}/docs/CONTENT_POLICY.md`,
    );
  });

  it('shows the actionable validation issues the API returns, not a generic message', async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          error: 'validation_error',
          message: 'The layout failed validation.',
          issues: [{ code: 'layout.grid.tiles_mismatch', path: 'tiles', message: 'Expected 4 tiles, got 2.' }],
        }),
        { status: 422 },
      ),
    );
    renderSubmit();
    await waitForAuthReady();

    fireEvent.change(screen.getByPlaceholderText(/version.*1/), { target: { value: VALID_LAYOUT } });
    fireEvent.click(screen.getByRole('button', { name: 'Check preview' }));

    // The message is a trailing text node beside a <code>path</code>
    // sibling, not its own element — substring match against the <li>.
    expect(await screen.findByText(/Expected 4 tiles, got 2\./, { exact: false })).toBeInTheDocument();
  });

  it('renders the returned preview image on a successful check', async () => {
    stubFetch(
      () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    renderSubmit();
    await waitForAuthReady();

    fireEvent.change(screen.getByPlaceholderText(/version.*1/), { target: { value: VALID_LAYOUT } });
    fireEvent.click(screen.getByRole('button', { name: 'Check preview' }));

    expect(await screen.findByAltText('Preview of your layout')).toBeInTheDocument();
  });

  it('publishes and navigates to the new layout on success', async () => {
    stubFetch(() =>
      Response.json({
        slug: 'my-new-office',
        title: 'My New Office',
        author: { discordId: '1', username: 'someone', displayName: 'someone', avatarUrl: null },
        description: '',
        tags: [],
        cols: 2,
        rows: 2,
        visibleCols: 2,
        visibleRows: 2,
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
        previewReady: true,
      }),
    );
    renderSubmit();
    await waitForAuthReady();

    fireEvent.change(screen.getByPlaceholderText(/version.*1/), { target: { value: VALID_LAYOUT } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My New Office' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(screen.getByText('landed on detail page')).toBeInTheDocument());
  });

  it('starts from the layout the editor handed over (#65)', async () => {
    stubFetch(() => new Response('{}', { status: 200 }));
    renderSubmit({ raw: VALID_LAYOUT });
    await waitForAuthReady();

    expect(screen.getByPlaceholderText(/version.*1/)).toHaveValue(VALID_LAYOUT);
    // Prefilled content is content: only the title is still missing.
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'From the editor' } });
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
  });

  it('disables Publish until both content and a title are present', async () => {
    stubFetch(() => new Response('{}', { status: 200 }));
    renderSubmit();
    await waitForAuthReady();

    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/version.*1/), { target: { value: VALID_LAYOUT } });
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled(); // still no title
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
  });
});
