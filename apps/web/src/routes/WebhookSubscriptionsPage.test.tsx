import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { requestUrl } from '../test/fetchStub';
import { WebhookSubscriptionsPage } from './WebhookSubscriptionsPage';

beforeEach(() => {
  location.hash = '#pixelIndexLoginCode=test-code';
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  location.hash = '';
});

const SUBSCRIPTION = {
  id: '46fe73a0-8c49-438f-a6df-bb5d3290551a',
  name: 'Pico',
  endpointUrl: 'https://pico.example/webhooks/pixel-index',
  secretHint: 'z9Qx',
  active: true,
  createdBy: { discordId: '1528094749993599038', username: 'moderator-person' },
  createdAt: '2026-08-15T12:00:00.000Z',
  updatedAt: '2026-08-15T12:00:00.000Z',
  secretRotatedAt: null,
  consecutiveFailures: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailure: null,
};

function authResponse(role: 'moderator' | 'admin') {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresInMs: 900_000,
    user: {
      id: 'moderator-1',
      discordId: '1528094749993599038',
      username: 'moderator-person',
      displayName: 'Moderator Person',
      avatarUrl: null,
      role,
      capabilityCheckedAt: null,
      capabilityCacheTtlMs: 60000,
      submission: { allowed: true, reason: null, inviteUrl: null },
    },
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider><WebhookSubscriptionsPage /></AuthProvider>
    </MemoryRouter>,
  );
}

describe('WebhookSubscriptionsPage', () => {
  it('creates a subscription and makes the one-time secret copy warning explicit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes('/auth/token')) return Response.json(authResponse('moderator'));
        if (url.endsWith('/api/v1/moderation/webhook-subscriptions') && init?.method === 'POST') {
          return Response.json(
            { subscription: SUBSCRIPTION, secret: 'whsec_only-shown-once' },
            { status: 201 },
          );
        }
        return Response.json({ subscriptions: [] });
      }),
    );
    renderPage();
    await screen.findByText('No subscriptions yet.');
    fireEvent.change(screen.getByLabelText('Service name'), { target: { value: 'Pico' } });
    fireEvent.change(screen.getByLabelText('HTTPS receiver URL'), {
      target: { value: 'https://pico.example/webhooks/pixel-index' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));

    expect(await screen.findByDisplayValue('whsec_only-shown-once')).toBeInTheDocument();
    expect(screen.getByText(/shown once and cannot be retrieved later/i)).toBeInTheDocument();
    expect(screen.getByText('Pico')).toBeInTheDocument();
    expect(screen.getByText(/secret ending z9Qx/)).toBeInTheDocument();
  });

  it('shows creator and delivery health to admins and lets them deactivate a service', async () => {
    const failing = {
      ...SUBSCRIPTION,
      consecutiveFailures: 2,
      lastFailure: 'subscriber returned HTTP 503',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes('/auth/token')) return Response.json(authResponse('admin'));
        if (url.includes('/api/v1/admin/webhook-subscriptions/') && init?.method === 'PATCH') {
          return Response.json({ ...failing, active: false });
        }
        return Response.json({ subscriptions: [failing] });
      }),
    );
    renderPage();
    expect(await screen.findByText(/Created by @moderator-person/)).toHaveTextContent(
      '1528094749993599038',
    );
    expect(screen.getByText(/2 failed events in a row/)).toHaveTextContent(
      'subscriber returned HTTP 503',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument());
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some(([input, init]) =>
      requestUrl(input).includes('/api/v1/admin/webhook-subscriptions/') && init?.method === 'PATCH',
    )).toBe(true);
  });
});
