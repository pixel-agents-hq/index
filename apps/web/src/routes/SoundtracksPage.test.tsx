import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Soundtrack } from '../api/types';
import { AuthProvider } from '../auth/AuthProvider';
import { RADIO_CHANNEL } from '../live-office/radioProtocol';
import { requestUrl } from '../test/fetchStub';
import { SoundtracksPage } from './SoundtracksPage';

const AUTHOR = { discordId: '42', username: 'dj', displayName: 'DJ', avatarUrl: null };
const SOUNDTRACK: Soundtrack = {
  id: '00000000-0000-4000-8000-000000000001',
  code: 'TOWN-5-8F3A21C0',
  mood: 'town',
  title: 'Morning standup',
  author: AUTHOR,
  createdAt: '2026-08-09T00:00:00.000Z',
};

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

let requests: { url: string; method: string; body: unknown }[] = [];

function stubApi(soundtracks = [SOUNDTRACK]) {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined });
      if (url.includes('/auth/token')) return Response.json(AUTH_RESPONSE);
      if (url.includes('/meta')) return Response.json(META_RESPONSE);
      if (url.includes('/api/v1/soundtracks') && method === 'POST') {
        return Response.json({ ...SOUNDTRACK, id: '00000000-0000-4000-8000-000000000002', code: 'RAIN-2-0000ABCD', mood: 'rain', title: null }, { status: 201 });
      }
      if (url.includes('/api/v1/soundtracks')) {
        return Response.json({ schemaVersion: 1, total: soundtracks.length, soundtracks, nextCursor: null });
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

function renderPage(entry = '/soundtracks') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <Routes>
          <Route path="/soundtracks" element={<SoundtracksPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** The radio frame, and a way to speak as it. */
function radioFrame() {
  const frame = screen.getByTitle('Office radio');
  if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) throw new Error('no radio frame');
  const contentWindow = frame.contentWindow;
  const postMessage = vi.spyOn(contentWindow, 'postMessage').mockImplementation(() => undefined);
  const say = (data: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data, origin: window.location.origin, source: contentWindow }));
    });
  return { postMessage, say };
}

beforeEach(() => {
  location.hash = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('SoundtracksPage', () => {
  it('lists soundtracks with the song code front and centre, and copies it', async () => {
    stubApi();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Morning standup' })).toBeInTheDocument();
    expect(screen.getByText('TOWN-5-8F3A21C0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('TOWN-5-8F3A21C0'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('asks the radio frame to name the tunes, and plays one through it', async () => {
    stubApi([{ ...SOUNDTRACK, title: null }]);
    renderPage();
    // Untitled and not yet named: the code is its heading too.
    await screen.findAllByText('TOWN-5-8F3A21C0');
    const { postMessage, say } = radioFrame();

    say({ channel: RADIO_CHANNEL, type: 'ready' });
    expect(postMessage).toHaveBeenCalledWith(
      { channel: RADIO_CHANNEL, type: 'describe', codes: ['TOWN-5-8F3A21C0'] },
      window.location.origin,
    );
    say({ channel: RADIO_CHANNEL, type: 'described', tunes: { 'TOWN-5-8F3A21C0': { name: 'Sunny Ledger Jig', key: 'D mixolydian' } } });
    // Untitled: the tune's own composed name stands in.
    expect(screen.getByRole('heading', { name: 'Sunny Ledger Jig' })).toBeInTheDocument();
    expect(screen.getByText('D mixolydian')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(postMessage).toHaveBeenLastCalledWith(
      { channel: RADIO_CHANNEL, type: 'play', code: 'TOWN-5-8F3A21C0' },
      window.location.origin,
    );
    say({ channel: RADIO_CHANNEL, type: 'state', code: 'TOWN-5-8F3A21C0', playing: true, blocked: false });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(postMessage).toHaveBeenLastCalledWith({ channel: RADIO_CHANNEL, type: 'pause' }, window.location.origin);
  });

  it('ignores messages that are not from its radio frame', async () => {
    stubApi([{ ...SOUNDTRACK, title: null }]);
    renderPage();
    // Untitled and not yet named: the code is its heading too.
    await screen.findAllByText('TOWN-5-8F3A21C0');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { channel: RADIO_CHANNEL, type: 'described', tunes: { 'TOWN-5-8F3A21C0': { name: 'Spoofed', key: 'x' } } },
          origin: window.location.origin,
          source: window,
        }),
      );
    });
    expect(screen.queryByRole('heading', { name: 'Spoofed' })).not.toBeInTheDocument();
  });

  it('filters by mood', async () => {
    stubApi();
    renderPage('/soundtracks?mood=rain');
    await screen.findByText('TOWN-5-8F3A21C0');
    expect(requests.some((r) => r.url.includes('/api/v1/soundtracks?') && r.url.includes('mood=rain'))).toBe(true);
  });

  it('publishes a song code for a signed-in member', async () => {
    location.hash = '#pixelIndexLoginCode=test-code';
    stubApi();
    renderPage();
    await screen.findByText('TOWN-5-8F3A21C0');

    fireEvent.change(await screen.findByLabelText('Song code'), { target: { value: 'rain-2-abcd' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect((await screen.findAllByText('RAIN-2-0000ABCD')).length).toBeGreaterThan(0);
    expect(requests.find((r) => r.method === 'POST' && r.url.includes('/api/v1/soundtracks'))?.body).toEqual({ code: 'rain-2-abcd' });
  });
});
