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
    say({
      channel: RADIO_CHANNEL,
      type: 'described',
      tunes: { 'TOWN-5-8F3A21C0': { code: 'TOWN-5-8F3A21C0', name: 'Sunny Ledger Jig', key: 'D mixolydian' } },
      invalid: [],
    });
    // Untitled: the tune's own composed name stands in.
    expect(screen.getByRole('heading', { name: 'Sunny Ledger Jig' })).toBeInTheDocument();
    expect(screen.getByText('D mixolydian')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(postMessage).toHaveBeenLastCalledWith(
      { channel: RADIO_CHANNEL, type: 'play', code: 'TOWN-5-8F3A21C0' },
      window.location.origin,
    );
    say({ channel: RADIO_CHANNEL, type: 'state', code: 'TOWN-5-8F3A21C0', playing: true, blocked: false, hidden: false });
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
          data: {
            channel: RADIO_CHANNEL,
            type: 'described',
            tunes: { 'TOWN-5-8F3A21C0': { code: 'TOWN-5-8F3A21C0', name: 'Spoofed', key: 'x' } },
            invalid: [],
          },
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

  it('tries a typed code on the radio before publishing, without an account', async () => {
    stubApi();
    renderPage();
    await screen.findByText('TOWN-5-8F3A21C0');
    const { postMessage, say } = radioFrame();
    say({ channel: RADIO_CHANNEL, type: 'ready' });

    const tryIt = screen.getByRole('button', { name: 'Try it' });
    expect(tryIt).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Song code'), { target: { value: ' night-2-abc ' } });
    // Once typing pauses, the radio is asked about the code (trimmed), as Pixel Agents' radio reads it.
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        { channel: RADIO_CHANNEL, type: 'describe', codes: ['night-2-abc'] },
        window.location.origin,
      ),
    );
    say({
      channel: RADIO_CHANNEL,
      type: 'described',
      tunes: { 'night-2-abc': { code: 'NIGHT-2-00000ABC', name: 'Idle Loop', key: 'E lydian' } },
      invalid: [],
    });
    expect(screen.getByText('Idle Loop')).toBeInTheDocument();
    expect(screen.getByText('NIGHT-2-00000ABC')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
    expect(postMessage).toHaveBeenLastCalledWith(
      { channel: RADIO_CHANNEL, type: 'play', code: 'NIGHT-2-00000ABC' },
      window.location.origin,
    );
    say({ channel: RADIO_CHANNEL, type: 'state', code: 'NIGHT-2-00000ABC', playing: true, blocked: false, hidden: false });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(postMessage).toHaveBeenLastCalledWith({ channel: RADIO_CHANNEL, type: 'pause' }, window.location.origin);
  });

  it('says when the radio can’t play a typed code, and won’t publish it', async () => {
    location.hash = '#pixelIndexLoginCode=test-code';
    stubApi();
    renderPage();
    await screen.findByText('TOWN-5-8F3A21C0');
    const { say } = radioFrame();
    say({ channel: RADIO_CHANNEL, type: 'ready' });

    fireEvent.change(await screen.findByLabelText('Song code'), { target: { value: 'JAZZ-1-0' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled());
    say({ channel: RADIO_CHANNEL, type: 'described', tunes: {}, invalid: ['JAZZ-1-0'] });

    expect(await screen.findByText('Not a song code the office radio can play.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Try it' })).toBeDisabled();
  });

  it('fits the frame to Pixel Agents’ player, and offers the way back when it was hidden', async () => {
    stubApi();
    renderPage();
    await screen.findByText('TOWN-5-8F3A21C0');
    const { postMessage, say } = radioFrame();
    const frame = screen.getByTitle('Office radio');

    say({ channel: RADIO_CHANNEL, type: 'size', height: 362 });
    expect(frame.style.height).toBe('362px');

    // "Hide player" in the player's own settings panel.
    say({ channel: RADIO_CHANNEL, type: 'state', code: 'TOWN-5-8F3A21C0', playing: false, blocked: false, hidden: true });
    fireEvent.click(screen.getByRole('button', { name: 'Show the radio' }));
    expect(postMessage).toHaveBeenLastCalledWith({ channel: RADIO_CHANNEL, type: 'show' }, window.location.origin);
    say({ channel: RADIO_CHANNEL, type: 'state', code: 'TOWN-5-8F3A21C0', playing: false, blocked: false, hidden: false });
    expect(screen.queryByRole('button', { name: 'Show the radio' })).not.toBeInTheDocument();
  });
});

