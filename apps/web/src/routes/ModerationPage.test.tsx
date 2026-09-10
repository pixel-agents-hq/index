import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { requestJson, requestUrl } from '../test/fetchStub';
import { ModerationPage } from './ModerationPage';

beforeEach(() => {
  location.hash = '#pixelIndexLoginCode=test-code';
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  location.hash = '';
});

const AUTH_RESPONSE = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresInMs: 900_000,
  user: { id: 'mod-1', username: 'mod-person', displayName: 'mod-person', avatarUrl: null, role: 'moderator', capabilityCheckedAt: null, capabilityCacheTtlMs: 60000, submission: { allowed: true, reason: null, inviteUrl: null } },
};

const ADMIN_AUTH_RESPONSE = {
  ...AUTH_RESPONSE,
  user: { ...AUTH_RESPONSE.user, id: 'admin-1', username: 'admin-person', role: 'admin' },
};

function ownerView(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'reported-office',
    title: 'Reported Office',
    author: { discordId: 'other-1', username: 'someone-else', displayName: 'someone-else', avatarUrl: null },
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
    visibility: 'public',
    visibilityReason: null,
    visibilityChangedAt: null,
    ...overrides,
  };
}

// Backs the MODERATORS.md link's repository/commit pin (see client.ts's
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
  authResponse: typeof AUTH_RESPONSE = AUTH_RESPONSE,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes('/auth/token')) return Response.json(authResponse);
      if (new URL(url).pathname === '/') return Response.json(ROOT_RESPONSE);
      return handleOther(url, init);
    }),
  );
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <ModerationPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('ModerationPage', () => {
  it('lists layouts across authors and visibilities', async () => {
    stubFetch(() =>
      Response.json({ schemaVersion: 1, total: 1, layouts: [ownerView()], nextCursor: null }),
    );
    renderPage();
    expect(await screen.findByText('Reported Office')).toBeInTheDocument();
    expect(screen.getByText(/someone-else/)).toBeInTheDocument();
  });

  it('links the moderator handbook, pinned to the running commit rather than a branch', async () => {
    stubFetch(() =>
      Response.json({ schemaVersion: 1, total: 0, layouts: [], nextCursor: null }),
    );
    renderPage();
    const link = await screen.findByRole('link', { name: 'MODERATORS.md' });
    expect(link).toHaveAttribute(
      'href',
      `${ROOT_RESPONSE.repository}/blob/${ROOT_RESPONSE.commit}/docs/MODERATORS.md`,
    );
  });

  it('does not let a slow response for the previous filter replace the current one', async () => {
    // The race this page could lose before #44's cancellation work: switch the
    // visibility filter and, if the abandoned request answers last, a moderator
    // ends up acting on rows belonging to a filter the page is no longer
    // showing.
    //
    // The stub resolves even after its signal fires, deliberately: that models
    // the ordering the `.then` guard exists for — the response having already
    // landed when the cleanup runs. A stub that rejected on abort would make
    // the guard unreachable and the test would pass without it.
    const pending = new Map<string, (response: Response) => void>();
    stubFetch((url) => {
      const filter = new URL(url, 'http://localhost').searchParams.get('visibility') ?? 'any';
      return new Promise<Response>((resolve) => {
        pending.set(filter, resolve);
      }) as unknown as Response;
    });

    renderPage();
    await waitFor(() => expect(pending.has('any')).toBe(true));

    fireEvent.change(screen.getByLabelText(/visibility/i), { target: { value: 'hidden' } });
    await waitFor(() => expect(pending.has('hidden')).toBe(true));

    pending.get('hidden')?.(
      Response.json({
        schemaVersion: 1,
        total: 1,
        layouts: [ownerView({ slug: 'hidden-office', title: 'Hidden Office', visibility: 'hidden' })],
        nextCursor: null,
      }),
    );
    expect(await screen.findByText('Hidden Office')).toBeInTheDocument();

    // The abandoned filter answers last and must be ignored.
    pending.get('any')?.(
      Response.json({
        schemaVersion: 1,
        total: 1,
        layouts: [ownerView({ slug: 'stale-office', title: 'Stale Office' })],
        nextCursor: null,
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByText('Hidden Office')).toBeInTheDocument();
    expect(screen.queryByText('Stale Office')).not.toBeInTheDocument();
  });

  it('sends the reason typed alongside a visibility change', async () => {
    let sentBody: { visibility?: string; reason?: string } = {};
    stubFetch((_url, init) => {
      if (init?.method === 'PATCH') {
        sentBody = requestJson<typeof sentBody>(init);
        return Response.json(ownerView({ visibility: 'hidden', visibilityReason: sentBody.reason }));
      }
      return Response.json({ schemaVersion: 1, total: 1, layouts: [ownerView()], nextCursor: null });
    });
    renderPage();
    await screen.findByText('Reported Office');

    const applyButton = screen.getByRole('button', { name: 'Apply' });
    // Scoped to the row rather than indexed out of every combobox on the page:
    // the page-level visibility filter is also one, and `getAllByRole(...)[1]`
    // silently follows whichever order the DOM happens to be in.
    const row = applyButton.closest('li, tr, form, div[data-layout]') ?? applyButton.parentElement;
    assert(row instanceof HTMLElement, 'the Apply button has no containing row');
    const rowVisibilitySelect = within(row).getByRole('combobox');
    fireEvent.change(rowVisibilitySelect, { target: { value: 'hidden' } });
    fireEvent.change(screen.getByPlaceholderText(/Reason/), { target: { value: 'inappropriate content' } });
    fireEvent.click(applyButton);

    await waitFor(() => expect(sentBody).toMatchObject({ visibility: 'hidden', reason: 'inappropriate content' }));
  });

  it('only offers public/hidden as PATCH targets — "removed" no longer exists (#72)', async () => {
    stubFetch(() =>
      Response.json({ schemaVersion: 1, total: 1, layouts: [ownerView()], nextCursor: null }),
    );
    renderPage();
    await screen.findByText('Reported Office');

    const applyButton = screen.getByRole('button', { name: 'Apply' });
    const row = applyButton.closest('li, tr, form, div[data-layout]') ?? applyButton.parentElement;
    assert(row instanceof HTMLElement, 'the Apply button has no containing row');
    const rowVisibilitySelect = within(row).getByRole('combobox');
    const optionValues = within(rowVisibilitySelect)
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);
    expect(optionValues).toEqual(['public', 'hidden']);
  });

  it('requires a reason before Delete is enabled, then sends a DELETE with that reason (#72)', async () => {
    let deleteReceived: { method: string; reason: string | undefined } | null = null;
    stubFetch((_url, init) => {
      if (init?.method === 'DELETE') {
        deleteReceived = { method: init.method, reason: requestJson<{ reason?: string }>(init).reason };
        return new Response(null, { status: 204 });
      }
      return Response.json({ schemaVersion: 1, total: 1, layouts: [ownerView()], nextCursor: null });
    });
    renderPage();
    await screen.findByText('Reported Office');

    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    expect(deleteButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/Reason/), { target: { value: 'confirmed violation' } });
    expect(deleteButton).not.toBeDisabled();

    fireEvent.click(deleteButton);

    await waitFor(() => expect(deleteReceived).toMatchObject({ method: 'DELETE', reason: 'confirmed violation' }));
    expect(await screen.findByText(/Deleted\./)).toBeInTheDocument();
  });

  it('shows the current slug in an editable field (#29)', async () => {
    stubFetch(() =>
      Response.json({ schemaVersion: 1, total: 1, layouts: [ownerView()], nextCursor: null }),
    );
    renderPage();
    await screen.findByText('Reported Office');
    expect(screen.getByLabelText('Slug')).toHaveValue('reported-office');
  });

  it('sends only the edited slug and the reason when the vanity slug alone changes', async () => {
    let sentBody: { slug?: string; visibility?: string; reason?: string } = {};
    stubFetch((_url, init) => {
      if (init?.method === 'PATCH') {
        sentBody = requestJson<typeof sentBody>(init);
        return Response.json(ownerView({ slug: sentBody.slug }));
      }
      return Response.json({ schemaVersion: 1, total: 1, layouts: [ownerView()], nextCursor: null });
    });
    renderPage();
    await screen.findByText('Reported Office');

    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'severance-office' } });
    fireEvent.change(screen.getByPlaceholderText(/Reason/), { target: { value: 'vanity url granted' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(sentBody).toMatchObject({ slug: 'severance-office', reason: 'vanity url granted' }),
    );
    expect(sentBody.visibility).toBeUndefined();
  });

  it('enables Apply when only the slug changes, not just visibility', async () => {
    stubFetch(() =>
      Response.json({ schemaVersion: 1, total: 1, layouts: [ownerView()], nextCursor: null }),
    );
    renderPage();
    await screen.findByText('Reported Office');

    const applyButton = screen.getByRole('button', { name: 'Apply' });
    expect(applyButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'severance-office' } });
    expect(applyButton).not.toBeDisabled();
  });

  it('keeps the row addressable across a rename, keyed by the slug it had before saving', async () => {
    let sentBody: { slug?: string; reason?: string } = {};
    stubFetch((_url, init) => {
      if (init?.method === 'PATCH') {
        sentBody = requestJson<typeof sentBody>(init);
        return Response.json(ownerView({ slug: sentBody.slug }));
      }
      return Response.json({ schemaVersion: 1, total: 1, layouts: [ownerView()], nextCursor: null });
    });
    renderPage();
    await screen.findByText('Reported Office');

    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'severance-office' } });
    fireEvent.change(screen.getByPlaceholderText(/Reason/), { target: { value: 'vanity url granted' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(screen.getByLabelText('Slug')).toHaveValue('severance-office'));
    // Exactly one row — the rename updated it in place rather than leaving a
    // stale duplicate behind under the pre-rename slug.
    expect(screen.getAllByLabelText('Slug')).toHaveLength(1);
  });

  it('does not show a "View history" link for a moderator (#29 follow-up)', async () => {
    stubFetch(() =>
      Response.json({ schemaVersion: 1, total: 1, layouts: [ownerView()], nextCursor: null }),
    );
    renderPage();
    await screen.findByText('Reported Office');
    expect(screen.queryByRole('link', { name: 'View history' })).not.toBeInTheDocument();
  });

  it('shows a "View history" link for an admin, deep-linking to that layout\'s filtered history', async () => {
    stubFetch(
      () => Response.json({ schemaVersion: 1, total: 1, layouts: [ownerView()], nextCursor: null }),
      ADMIN_AUTH_RESPONSE,
    );
    renderPage();
    await screen.findByText('Reported Office');
    expect(screen.getByRole('link', { name: 'View history' })).toHaveAttribute(
      'href',
      '/admin/history?slug=reported-office',
    );
  });

  it('re-fetches when the visibility filter changes', async () => {
    let lastUrl = '';
    stubFetch((url) => {
      lastUrl = url;
      return Response.json({ schemaVersion: 1, total: 0, layouts: [], nextCursor: null });
    });
    renderPage();
    await screen.findByText('Nothing matches.');

    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'hidden' } });
    await waitFor(() => expect(lastUrl).toContain('visibility=hidden'));
  });
});
