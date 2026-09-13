import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { LIVE_OFFICE_CHANNEL } from '../live-office/protocol';
import { requestBody, requestUrl } from '../test/fetchStub';
import { LayoutEditorPage } from './LayoutEditorPage';
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
  user: {
    id: '1',
    discordId: 'owner-1',
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
  pixelAgents: { version: '1.4.0', commit: null, layoutRevision: 4 },
  count: 1,
  discordInviteUrl: null as string | null,
};

const SOURCE_LAYOUT = { version: 1, layoutRevision: 4, cols: 2, rows: 2, tiles: [0, 0, 0, 0], furniture: [] };

function assetDetail(overrides: Record<string, unknown> = {}) {
  return {
    assetId: 'CUSTOM_LAMP',
    assetKind: 'furniture',
    name: 'Custom Lamp',
    category: 'decor',
    source: 'custom',
    author: { discordId: null, username: 'someone', displayName: 'someone', avatarUrl: null },
    tags: ['static'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    files: { sprite: '/api/v1/assets/CUSTOM_LAMP/sprite.png' },
    manifest: [{ id: 'CUSTOM_LAMP' }],
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'blue-office',
    title: 'Blue Office',
    author: { discordId: 'owner-1', username: 'someone', displayName: 'someone', avatarUrl: null },
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
    seats: 0,
    layoutRevision: 4,
    pixelAgentsVersion: '1.4.0',
    bytes: 10,
    sha256: 'a'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    files: { layout: '', preview: '', thumbnail: '' },
    layout: SOURCE_LAYOUT,
    ...overrides,
  };
}

function stubFetch(
  handleOther: (url: string, init?: RequestInit) => Response = () => new Response('{}'),
  authResponse: unknown = AUTH_RESPONSE,
  metaResponse: unknown = META_RESPONSE,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes('/auth/token')) return Response.json(authResponse);
      if (url.includes('/meta')) return Response.json(metaResponse);
      return handleOther(url, init);
    }),
  );
}

function renderEditor(
  entry: string,
  handleOther?: (url: string, init?: RequestInit) => Response,
  metaResponse?: unknown,
) {
  stubFetch(handleOther, undefined, metaResponse);
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <Routes>
          <Route path="editor" element={<LayoutEditorPage />} />
          <Route path="layouts/:slug/edit" element={<LayoutEditorPage />} />
          <Route path="layouts/:slug" element={<p>landed on detail page</p>} />
          <Route path="submit" element={<SubmitPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** The window inside the editor's frame — see LiveOfficePreview.test.tsx for why this is narrowed rather than asserted. */
async function editorWindow(): Promise<Window> {
  const iframe = await screen.findByTitle('Pixel Agents office editor');
  if (!(iframe instanceof HTMLIFrameElement)) {
    throw new Error('the editor did not render an iframe');
  }
  const frameWindow = iframe.contentWindow;
  if (!frameWindow) throw new Error('the editor iframe has no contentWindow');
  return frameWindow;
}

function fromFrame(frameWindow: Window, data: unknown) {
  fireEvent(
    window,
    new MessageEvent('message', { source: frameWindow, origin: window.location.origin, data }),
  );
}

describe('LayoutEditorPage', () => {
  it('asks the frame for a blank layout, stamped with the revision the API validates against', async () => {
    renderEditor('/editor');
    const frameWindow = await editorWindow();
    const postMessage = vi.spyOn(frameWindow, 'postMessage').mockReturnValue(undefined);

    fromFrame(frameWindow, { channel: LIVE_OFFICE_CHANNEL, type: 'ready' });

    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        {
          channel: LIVE_OFFICE_CHANNEL,
          type: 'edit',
          // `null` is the request for upstream's blank room — the parent
          // cannot build one without importing vendor code.
          layout: null,
          layoutRevision: 4,
        },
        window.location.origin,
      ),
    );
  });

  it('hands the layout the frame produced to the submit form', async () => {
    renderEditor('/editor');
    const frameWindow = await editorWindow();
    vi.spyOn(frameWindow, 'postMessage').mockReturnValue(undefined);

    expect(screen.getByRole('button', { name: 'Continue to publish' })).toBeDisabled();

    const drawn = JSON.stringify({ ...SOURCE_LAYOUT, tiles: [1, 1, 1, 1] });
    fromFrame(frameWindow, { channel: LIVE_OFFICE_CHANNEL, type: 'layout', layout: drawn });

    const button = screen.getByRole('button', { name: 'Continue to publish' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    expect(await screen.findByPlaceholderText(/version.*1/)).toHaveValue(drawn);
  });

  it('seeds the frame from a published layout when starting from a copy of one', async () => {
    renderEditor('/editor?from=blue-office', () => Response.json(detail()));
    const frameWindow = await editorWindow();
    const postMessage = vi.spyOn(frameWindow, 'postMessage').mockReturnValue(undefined);

    fromFrame(frameWindow, { channel: LIVE_OFFICE_CHANNEL, type: 'ready' });

    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'edit', layout: SOURCE_LAYOUT }),
        window.location.origin,
      ),
    );
    // A copy is a new layout, not a replacement of the one it came from.
    expect(screen.getByRole('button', { name: 'Continue to publish' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('re-seeds the frame with an imported layout.json', async () => {
    renderEditor('/editor');
    const frameWindow = await editorWindow();
    const postMessage = vi.spyOn(frameWindow, 'postMessage').mockReturnValue(undefined);
    fromFrame(frameWindow, { channel: LIVE_OFFICE_CHANNEL, type: 'ready' });
    await waitFor(() => expect(postMessage).toHaveBeenCalled());

    const imported = { ...SOURCE_LAYOUT, cols: 3, rows: 1, tiles: [1, 1, 1] };
    fireEvent.change(screen.getByLabelText(/import a layout.json/), {
      target: { files: [new File([JSON.stringify(imported)], 'layout.json', { type: 'application/json' })] },
    });

    await waitFor(() =>
      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'edit', layout: imported }),
        window.location.origin,
      ),
    );
  });

  it('rejects a file that is not JSON before anything reaches the frame', async () => {
    renderEditor('/editor');
    const frameWindow = await editorWindow();
    vi.spyOn(frameWindow, 'postMessage').mockReturnValue(undefined);

    fireEvent.change(screen.getByLabelText(/import a layout.json/), {
      target: { files: [new File(['not json at all'], 'layout.json', { type: 'application/json' })] },
    });

    expect(await screen.findByText('That file is not valid JSON.')).toBeInTheDocument();
  });

  it('replaces an existing layout with the edited bytes, and only once they differ', async () => {
    const requests: { url: string; body: string }[] = [];
    renderEditor('/layouts/blue-office/edit', (url, init) => {
      if (url.endsWith('/blue-office/layout')) {
        requests.push({ url, body: requestBody(init) });
        return Response.json({ ...detail(), previewReady: true });
      }
      return Response.json(detail());
    });
    const frameWindow = await editorWindow();
    vi.spyOn(frameWindow, 'postMessage').mockReturnValue(undefined);

    const opened = JSON.stringify(SOURCE_LAYOUT);
    fromFrame(frameWindow, { channel: LIVE_OFFICE_CHANNEL, type: 'layout', layout: opened });
    // The layout as it was opened is not a change, however many times the
    // frame reports it.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled());

    const edited = JSON.stringify({ ...SOURCE_LAYOUT, tiles: [1, 1, 1, 1] });
    fromFrame(frameWindow, { channel: LIVE_OFFICE_CHANNEL, type: 'layout', layout: edited });
    const save = screen.getByRole('button', { name: 'Save changes' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    await waitFor(() => expect(screen.getByText('landed on detail page')).toBeInTheDocument());
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toBe(edited);
  });

  it('says whose layout it is instead of pretending a stranger can save it', async () => {
    renderEditor('/layouts/blue-office/edit', () =>
      Response.json(
        detail({
          author: { discordId: 'somebody-else', username: 'other', displayName: 'other', avatarUrl: null },
        }),
      ),
    );

    expect(
      await screen.findByText(
        'This layout belongs to someone else — only its owner can save changes to it.',
      ),
    ).toBeInTheDocument();
  });

  it('lets an anonymous visitor draw and check a preview on the create path, but keeps publish gated (#85)', async () => {
    location.hash = '';
    renderEditor('/editor', undefined, {
      ...META_RESPONSE,
      discordInviteUrl: 'https://discord.gg/pixel-index',
    });

    // The canvas itself is not gated — it renders straight away.
    const frameWindow = await editorWindow();
    vi.spyOn(frameWindow, 'postMessage').mockReturnValue(undefined);

    expect(
      await screen.findByText(
        'Publishing a layout is available to members of the official Discord community. Log in with Discord to check your membership.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in with Discord' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Join the Discord server' })).toHaveAttribute(
      'href',
      'https://discord.gg/pixel-index',
    );

    const drawn = JSON.stringify({ ...SOURCE_LAYOUT, tiles: [1, 1, 1, 1] });
    fromFrame(frameWindow, { channel: LIVE_OFFICE_CHANNEL, type: 'layout', layout: drawn });

    // Drawing produces bytes, and Check preview works on them without
    // logging in — preview-check doesn't persist anything or need Discord
    // membership. Only the publish hand-off is gated.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check preview' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Continue to publish' })).toBeDisabled();
  });

  it('renders a real preview for an anonymous visitor on the create path (#85)', async () => {
    location.hash = '';
    renderEditor('/editor', (url) =>
      url.includes('/preview-check')
        ? new Response(new Uint8Array([137, 80, 78, 71]), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          })
        : new Response('{}'),
    );
    const frameWindow = await editorWindow();
    vi.spyOn(frameWindow, 'postMessage').mockReturnValue(undefined);

    const drawn = JSON.stringify({ ...SOURCE_LAYOUT, tiles: [1, 1, 1, 1] });
    fromFrame(frameWindow, { channel: LIVE_OFFICE_CHANNEL, type: 'layout', layout: drawn });

    const button = await screen.findByRole('button', { name: 'Check preview' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    expect(await screen.findByAltText('Preview of your layout')).toBeInTheDocument();
  });

  it('still lets an anonymous visitor import a layout.json on the create path (#85)', async () => {
    location.hash = '';
    renderEditor('/editor');
    const frameWindow = await editorWindow();
    const postMessage = vi.spyOn(frameWindow, 'postMessage').mockReturnValue(undefined);
    fromFrame(frameWindow, { channel: LIVE_OFFICE_CHANNEL, type: 'ready' });
    await waitFor(() => expect(postMessage).toHaveBeenCalled());

    const imported = { ...SOURCE_LAYOUT, cols: 3, rows: 1, tiles: [1, 1, 1] };
    fireEvent.change(screen.getByLabelText(/import a layout.json/), {
      target: { files: [new File([JSON.stringify(imported)], 'layout.json', { type: 'application/json' })] },
    });

    await waitFor(() =>
      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'edit', layout: imported }),
        window.location.origin,
      ),
    );
  });

  it('keeps the edit-existing path fully gated for an anonymous visitor (#85 is create-path only)', async () => {
    location.hash = '';
    renderEditor('/layouts/blue-office/edit', () => Response.json(detail()));

    expect(
      await screen.findByText(
        'The layout editor is available to members of the official Discord community. Log in with Discord to check your membership.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTitle('Pixel Agents office editor')).not.toBeInTheDocument();
  });

  describe('single-asset inspection editor (#121)', () => {
    it('names the asset, loads it into the frame, and never offers a publish action', async () => {
      renderEditor('/editor?asset=CUSTOM_LAMP', (url) =>
        url.endsWith('/assets/CUSTOM_LAMP') ? Response.json(assetDetail()) : Response.json({}),
      );

      expect(await screen.findByRole('heading', { name: 'Try “Custom Lamp”' })).toBeInTheDocument();
      const iframe = await screen.findByTitle('Pixel Agents office editor');
      expect(iframe).toHaveAttribute('src', expect.stringContaining('asset=CUSTOM_LAMP'));

      // Genuinely unavailable, not merely disabled or hidden — see LayoutEditorPage.tsx.
      expect(screen.queryByRole('button', { name: 'Continue to publish' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Check preview' })).toBeInTheDocument();
    });

    it('ignores ?asset= when replacing an existing layout — the two modes do not combine', async () => {
      renderEditor('/layouts/blue-office/edit?asset=CUSTOM_LAMP', (url) =>
        url.endsWith('/assets/CUSTOM_LAMP') ? Response.json(assetDetail()) : Response.json(detail()),
      );

      expect(await screen.findByRole('heading', { name: 'Edit layout' })).toBeInTheDocument();
      const iframe = await screen.findByTitle('Pixel Agents office editor');
      expect(iframe).not.toHaveAttribute('src', expect.stringContaining('asset='));
    });
  });
});
