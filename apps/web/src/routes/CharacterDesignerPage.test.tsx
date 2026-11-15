import { profileFromText } from '@pixel-index/pixatar';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { DESIGNER_CHANNEL } from '../live-office/designerProtocol';
import { requestUrl } from '../test/fetchStub';
import { CharacterDesignerPage } from './CharacterDesignerPage';

const AUTH_RESPONSE = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresInMs: 900_000,
  user: {
    id: '1',
    username: 'someone',
    displayName: 'someone',
    avatarUrl: null,
    discordId: '7',
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
  discordInviteUrl: null,
};
const REMIX = { id: 'abc', name: 'Night Owl', body: 'flat', v: 35 };

let uploads: { url: string; body: string; contentType: string | undefined }[] = [];

function stubApi() {
  uploads = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes('/auth/token')) return Response.json(AUTH_RESPONSE);
      if (url.includes('/meta')) return Response.json(META_RESPONSE);
      if (url.includes('/profile.json')) return Response.json(REMIX);
      if (url.includes('/api/v1/assets') && init?.method === 'POST') {
        uploads.push({
          url,
          body: await (init.body as Blob).text(),
          contentType: (init.headers as Record<string, string> | undefined)?.['content-type'],
        });
        return Response.json({ assetId: 'NIGHT_OWL' }, { status: 201 });
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

function renderPage(entry = '/assets/design') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <Routes>
          <Route path="/assets/design" element={<CharacterDesignerPage />} />
          <Route path="/assets/:id" element={<p>landed on asset detail page</p>} />
          <Route path="/assets" element={<p>landed on the gallery</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function designerFrame() {
  const frame = screen.getByTitle('Character designer');
  if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) throw new Error('no designer frame');
  const contentWindow = frame.contentWindow;
  const postMessage = vi.spyOn(contentWindow, 'postMessage').mockImplementation(() => undefined);
  const say = (data: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data, origin: window.location.origin, source: contentWindow }));
    });
  return { postMessage, say };
}

beforeEach(() => {
  location.hash = '#pixelIndexLoginCode=test-code';
  // jsdom has no canvas; the seed panel draws nothing without one.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  location.hash = '';
});

describe('CharacterDesignerPage', () => {
  it('publishes the character on the designer’s stage as a character profile', async () => {
    stubApi();
    renderPage();
    const { say } = designerFrame();
    say({ channel: DESIGNER_CHANNEL, type: 'selection', profile: REMIX, customItems: [] });

    const publish = await screen.findByRole('button', { name: 'Publish “Night Owl”' });
    await waitFor(() => expect(publish).toBeEnabled());
    fireEvent.click(publish);

    expect(await screen.findByText('landed on asset detail page')).toBeInTheDocument();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.url).toContain('fileName=Night+Owl.json');
    expect(uploads[0]?.contentType).toBe('application/json');
    expect(JSON.parse(uploads[0]?.body ?? '')).toEqual(REMIX);
  });

  it('won’t publish a character wearing a custom item, and says why', async () => {
    stubApi();
    renderPage();
    const { say } = designerFrame();
    say({ channel: DESIGNER_CHANNEL, type: 'selection', profile: REMIX, customItems: ['custom_hat1'] });

    expect(await screen.findByRole('status')).toHaveTextContent('custom_hat1');
    expect(screen.getByRole('button', { name: 'Publish “Night Owl”' })).toBeDisabled();
  });

  it('opens a copy of a published profile when asked ?from=, once the frame is listening', async () => {
    stubApi();
    renderPage('/assets/design?from=NIGHT_OWL');
    const { postMessage, say } = designerFrame();
    say({ channel: DESIGNER_CHANNEL, type: 'ready' });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        { channel: DESIGNER_CHANNEL, type: 'open', profile: REMIX },
        window.location.origin,
      ),
    );
  });

  it('goes back to the gallery when the Characters view is closed', async () => {
    stubApi();
    renderPage();
    designerFrame().say({ channel: DESIGNER_CHANNEL, type: 'close' });
    expect(await screen.findByText('landed on the gallery')).toBeInTheDocument();
  });

  it('lets an anonymous visitor design and remix, with Publish shown but disabled', async () => {
    location.hash = '';
    stubApi();
    renderPage('/assets/design?from=NIGHT_OWL');
    const { postMessage, say } = designerFrame();
    say({ channel: DESIGNER_CHANNEL, type: 'ready' });
    // Remixing a published profile needs no account.
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        { channel: DESIGNER_CHANNEL, type: 'open', profile: REMIX },
        window.location.origin,
      ),
    );
    say({ channel: DESIGNER_CHANNEL, type: 'selection', profile: REMIX, customItems: [] });

    expect(screen.getByRole('button', { name: 'Publish “Night Owl”' })).toBeDisabled();
    expect(
      await screen.findByText(/Publishing characters is available to members of the official Discord community\./),
    ).toBeInTheDocument();
    expect(uploads).toHaveLength(0);
  });

  describe('seeds', () => {
    // pinned by packages/pixatar/test/pinned.test.ts: what the text "octocat" makes at this vendor pin
    const OCTOCAT = 'px.ASMByrHtCcOaAj1fXEBDyipVOErZBwFd2AE_HAZdVTbyDX2JAR3X5AldBTX_Cn2IAR3U-gBCXzgIdbQBurY';
    const wearOf = (text: string) => ({ channel: DESIGNER_CHANNEL, type: 'wear', profile: profileFromText(text) });

    it('dresses the stage as the address’s seed once the frame is listening', async () => {
      stubApi();
      renderPage('/assets/design?text=octocat');
      const { postMessage, say } = designerFrame();
      await screen.findByRole('region', { name: 'Seed' });
      expect(postMessage).not.toHaveBeenCalled();
      say({ channel: DESIGNER_CHANNEL, type: 'ready' });
      await waitFor(() => expect(postMessage).toHaveBeenCalledWith(wearOf('octocat'), window.location.origin));
    });

    it('opens ?from= rather than the address’s seed', async () => {
      stubApi();
      renderPage(`/assets/design?from=NIGHT_OWL&seed=${OCTOCAT}`);
      const { postMessage, say } = designerFrame();
      await screen.findByRole('region', { name: 'Seed' });
      say({ channel: DESIGNER_CHANNEL, type: 'ready' });
      await waitFor(() =>
        expect(postMessage).toHaveBeenCalledWith(
          { channel: DESIGNER_CHANNEL, type: 'open', profile: REMIX },
          window.location.origin,
        ),
      );
      expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'wear' }), window.location.origin);
    });

    it('says what is wrong with a seed code in the address', async () => {
      stubApi();
      renderPage('/assets/design?seed=px.!!!');
      expect(await screen.findByRole('alert')).toHaveTextContent(/seed code/i);
    });

    it('makes the character of the text as it is typed', async () => {
      stubApi();
      renderPage();
      const { postMessage, say } = designerFrame();
      say({ channel: DESIGNER_CHANNEL, type: 'ready' });
      fireEvent.change(await screen.findByLabelText('Free-text seed'), { target: { value: 'octocat' } });
      await waitFor(() => expect(postMessage).toHaveBeenCalledWith(wearOf('octocat'), window.location.origin));
      expect(postMessage).toHaveBeenCalledTimes(1);
    });

    it('wears a pasted seed code on Make', async () => {
      stubApi();
      renderPage();
      const { postMessage, say } = designerFrame();
      say({ channel: DESIGNER_CHANNEL, type: 'ready' });
      fireEvent.click(await screen.findByRole('button', { name: 'Seed code' }));
      fireEvent.change(screen.getByLabelText('Seed code'), { target: { value: OCTOCAT } });
      fireEvent.click(screen.getByRole('button', { name: 'Make' }));
      expect(postMessage).toHaveBeenCalledWith(wearOf('octocat'), window.location.origin);
    });

    it('shows the seed code of the character on the stage, and the toggle saves transparency in it', async () => {
      stubApi();
      renderPage();
      const { say } = designerFrame();
      await screen.findByRole('region', { name: 'Seed' });
      say({
        channel: DESIGNER_CHANNEL,
        type: 'selection',
        profile: { ...profileFromText('octocat'), id: 'char-0', name: 'Octo' },
        customItems: [],
      });
      expect(await screen.findByTestId('seed-code')).toHaveTextContent(OCTOCAT);
      fireEvent.click(screen.getByLabelText('Transparent avatar'));
      expect(screen.getByTestId('seed-code')).toHaveTextContent(`px.E${OCTOCAT.slice(4)}`);
    });
  });
});
