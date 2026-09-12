import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { requestUrl } from '../test/fetchStub';
import { AssetSubmitPage } from './AssetSubmitPage';

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
  user: {
    id: '1',
    username: 'someone',
    displayName: 'someone',
    avatarUrl: null,
    role: 'user',
    capabilityCheckedAt: null,
    capabilityCacheTtlMs: 60000,
    submission: { allowed: true, reason: null, inviteUrl: null },
  },
};

const META_RESPONSE = {
  schemaVersion: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  pixelAgents: { version: null, commit: null, layoutRevision: 0 },
  count: 0,
  discordInviteUrl: null as string | null,
};

const FURNITURE_CATEGORIES = ['chairs', 'decor', 'desks', 'electronics', 'misc', 'wall'];

function stubFetch(handleOther: (url: string) => Response, authResponse: unknown = AUTH_RESPONSE) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes('/auth/token')) return Response.json(authResponse);
      if (url.includes('/meta')) return Response.json(META_RESPONSE);
      if (url.includes('furniture-categories.json')) return Response.json(FURNITURE_CATEGORIES);
      return handleOther(url);
    }),
  );
}

function renderSubmit() {
  return render(
    <MemoryRouter initialEntries={['/assets/submit']}>
      <AuthProvider>
        <Routes>
          <Route path="/assets/submit" element={<AssetSubmitPage />} />
          <Route path="/assets/:id" element={<p>landed on asset detail page</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function waitForAuthReady() {
  await screen.findByRole('button', { name: 'Publish' });
}

function chooseFile() {
  const file = new File([new Blob([new Uint8Array([1, 2, 3])])], 'asset.zip', { type: 'application/zip' });
  const input = screen.getByLabelText('Asset zip');
  fireEvent.change(input, { target: { files: [file] } });
}

describe('AssetSubmitPage', () => {
  it('gates the form behind submission capability, same as SubmitPage', async () => {
    stubFetch(
      () => new Response('{}', { status: 200 }),
      {
        ...AUTH_RESPONSE,
        user: {
          ...AUTH_RESPONSE.user,
          submission: { allowed: false, reason: 'discord_membership_required' as const, inviteUrl: null },
        },
      },
    );
    renderSubmit();
    expect(
      await screen.findByText(/Custom asset uploads is available to members of the official Discord community\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
  });

  it('disables Publish until both a file and a name are present', async () => {
    stubFetch(() => new Response('{}', { status: 200 }));
    renderSubmit();
    await waitForAuthReady();

    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    chooseFile();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled(); // still no name
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Chair' } });
    // Category seeds asynchronously once furniture-categories.json resolves.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled());
  });

  it('publishes and navigates to the new asset on success', async () => {
    stubFetch(() =>
      Response.json({
        assetId: 'MY_CHAIR',
        name: 'My Chair',
        category: 'chairs',
        author: { discordId: '1', username: 'someone', displayName: 'someone', avatarUrl: null },
        tags: ['static'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        files: { sprite: '/api/v1/assets/MY_CHAIR/sprite.png' },
        manifest: [{ id: 'MY_CHAIR' }],
      }),
    );
    renderSubmit();
    await waitForAuthReady();

    chooseFile();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Chair' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(screen.getByText('landed on asset detail page')).toBeInTheDocument());
  });

  it('shows the actionable validation issues the API returns', async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          error: 'validation_error',
          message: 'Invalid manifest.json.',
          issues: [{ code: 'meta.schema', path: '/id', message: 'id must start with an uppercase letter.' }],
        }),
        { status: 422 },
      ),
    );
    renderSubmit();
    await waitForAuthReady();

    chooseFile();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Chair' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect(await screen.findByText(/id must start with an uppercase letter\./, { exact: false })).toBeInTheDocument();
  });
});
