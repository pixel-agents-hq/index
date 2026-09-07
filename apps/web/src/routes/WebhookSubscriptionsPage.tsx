import { type SyntheticEvent, useEffect, useState } from 'react';

import { ApiError } from '../api/client';
import {
  createWebhookSubscription,
  getWebhookSubscriptions,
  rotateWebhookSubscriptionSecret,
  setWebhookSubscriptionActive,
} from '../api/moderationClient';
import type { WebhookSubscriptionView } from '../api/types';
import { useAuth } from '../auth/authState';
import { ErrorNotice } from '../components/ErrorNotice';
import { clipboardWriteText, copyViaSelection } from '../platform/clipboard';

async function copyText(value: string): Promise<void> {
  const writer = clipboardWriteText();
  if (writer) await writer(value);
  else copyViaSelection(value);
}

function health(subscription: WebhookSubscriptionView): string {
  if (!subscription.active) return 'Inactive';
  if (subscription.consecutiveFailures > 0) {
    return `${subscription.consecutiveFailures} failed event${subscription.consecutiveFailures === 1 ? '' : 's'} in a row`;
  }
  if (subscription.lastSuccessAt) {
    return `Healthy · last delivered ${new Date(subscription.lastSuccessAt).toLocaleString()}`;
  }
  return 'Waiting for its first event';
}

export function WebhookSubscriptionsPage() {
  const { accessToken, user } = useAuth();
  const [subscriptions, setSubscriptions] = useState<WebhookSubscriptionView[] | null>(null);
  const [name, setName] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    getWebhookSubscriptions(accessToken, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setSubscriptions(response.subscriptions);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
      });
    return () => controller.abort();
  }, [accessToken]);

  function replace(updated: WebhookSubscriptionView) {
    setSubscriptions((current) =>
      current?.map((entry) => (entry.id === updated.id ? updated : entry)) ?? null,
    );
  }

  async function create(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) return;
    setSaving(true);
    setError(null);
    setSecret(null);
    try {
      const created = await createWebhookSubscription(
        { name: name.trim(), endpointUrl: endpointUrl.trim() },
        accessToken,
      );
      setSubscriptions((current) => [created.subscription, ...(current ?? [])]);
      setSecret(created.secret);
      setCopyStatus('idle');
      setName('');
      setEndpointUrl('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
    } finally {
      setSaving(false);
    }
  }

  async function rotate(subscription: WebhookSubscriptionView) {
    if (!accessToken || !confirm(`Rotate the secret for "${subscription.name}"? Its current secret will stop working immediately.`)) return;
    setSaving(true);
    setError(null);
    try {
      const rotated = await rotateWebhookSubscriptionSecret(subscription.id, accessToken);
      replace(rotated.subscription);
      setSecret(rotated.secret);
      setCopyStatus('idle');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
    } finally {
      setSaving(false);
    }
  }

  async function setActive(subscription: WebhookSubscriptionView, active: boolean) {
    if (!accessToken) return;
    setSaving(true);
    setError(null);
    try {
      replace(await setWebhookSubscriptionActive(subscription.id, active, accessToken));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
    } finally {
      setSaving(false);
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await copyText(secret);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }

  return (
    <div>
      <h1 className="font-display text-2xl text-ink">Webhook subscriptions</h1>
      <p className="mt-1 text-sm text-muted">
        Create an HTTPS receiver for <code>layout.shared</code> events. Admins can see every
        service and its creating moderator; moderators see subscriptions they created.
      </p>

      <form onSubmit={(event) => void create(event)} className="mt-6 border-2 border-border p-4">
        <h2 className="font-display text-lg text-ink">Create a subscription</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-muted">
            Service name
            <input
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Pico Discord Bot"
              className="mt-1 block w-full border border-border bg-canvas px-3 py-2 text-ink"
            />
          </label>
          <label className="text-sm text-muted">
            HTTPS receiver URL
            <input
              required
              type="url"
              value={endpointUrl}
              onChange={(event) => setEndpointUrl(event.target.value)}
              placeholder="https://pico.example/webhooks/pixel-index"
              className="mt-1 block w-full border border-border bg-canvas px-3 py-2 text-ink"
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={saving}
          className="mt-3 border-2 border-accent px-4 py-2 text-sm text-accent disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Create subscription'}
        </button>
      </form>

      {secret && (
        <section className="mt-4 border-2 border-accent bg-surface p-4" aria-labelledby="new-secret-heading">
          <h2 id="new-secret-heading" className="font-display text-lg text-ink">Copy this secret now</h2>
          <p className="mt-1 text-sm text-danger">
            It is shown once and cannot be retrieved later. Store it in the receiver&apos;s secret manager.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              readOnly
              aria-label="New webhook secret"
              value={secret}
              className="min-w-0 flex-1 border border-border bg-canvas px-3 py-2 font-mono text-sm text-ink"
            />
            <button type="button" onClick={() => void copySecret()} className="border-2 border-accent px-4 py-2 text-sm text-accent">
              Copy secret
            </button>
            <button type="button" onClick={() => setSecret(null)} className="border-2 border-border px-4 py-2 text-sm text-ink">
              I have stored it
            </button>
          </div>
          <p className="mt-1 min-h-5 text-sm text-muted" role="status" aria-live="polite">
            {copyStatus === 'copied' && 'Secret copied.'}
            {copyStatus === 'failed' && 'Copy failed. Select the secret above and copy it manually.'}
          </p>
        </section>
      )}

      {error && <div className="mt-4"><ErrorNotice error={error} /></div>}
      <section className="mt-8" aria-labelledby="existing-subscriptions-heading">
        <h2 id="existing-subscriptions-heading" className="font-display text-xl text-ink">
          Existing subscriptions
        </h2>
        {subscriptions === null && !error && <p className="mt-3 text-muted">Loading subscriptions…</p>}
        {subscriptions?.length === 0 && <p className="mt-3 text-muted">No subscriptions yet.</p>}
        {subscriptions && subscriptions.length > 0 && (
          <ul className="mt-3 flex list-none flex-col gap-3 p-0">
            {subscriptions.map((subscription) => {
              const mayRotate = user?.role === 'admin' || user?.discordId === subscription.createdBy.discordId;
              return (
                <li key={subscription.id} className="border-2 border-border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{subscription.name}</p>
                      <p className="break-all font-mono text-xs text-muted">{subscription.endpointUrl}</p>
                      <p className="mt-1 text-xs text-subtle">
                        Created by @{subscription.createdBy.username} ({subscription.createdBy.discordId}) ·{' '}
                        {new Date(subscription.createdAt).toLocaleString()} · secret ending {subscription.secretHint}
                      </p>
                      <p className={`mt-2 text-sm ${subscription.consecutiveFailures > 0 ? 'text-danger' : 'text-muted'}`}>
                        {health(subscription)}
                        {subscription.lastFailure && <> — {subscription.lastFailure}</>}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {mayRotate && (
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void rotate(subscription)}
                          className="border border-border px-3 py-1.5 text-sm text-ink disabled:opacity-50"
                        >
                          Rotate secret
                        </button>
                      )}
                      {user?.role === 'admin' && (
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void setActive(subscription, !subscription.active)}
                          className="border border-border px-3 py-1.5 text-sm text-ink disabled:opacity-50"
                        >
                          {subscription.active ? 'Deactivate' : 'Reactivate'}
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
