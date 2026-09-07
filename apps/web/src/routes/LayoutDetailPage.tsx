import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ApiError, getLayout, getLayoutJson, getMeta } from '../api/client';
import { shareLayout } from '../api/manageClient';
import { previewImageProps, usePreviewSource } from '../api/previewSourceState';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/authState';
import { AuthorLink } from '../components/AuthorLink';
import { ErrorNotice } from '../components/ErrorNotice';
import { factsFor } from '../components/facts';
import { FactsRow } from '../components/FactsRow';
import { LayoutJsonPanel, type LayoutJsonState } from '../components/LayoutJsonPanel';
import { LiveOfficePreview } from '../components/LiveOfficePreview';

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function LayoutDetailPage() {
  // react-router types every param as optional because it cannot prove the
  // route pattern; App.tsx registers this component only under
  // `layouts/:slug`, so an absent slug is a routing bug, not a request to
  // handle. Thrown before any hook runs, so the hook count cannot vary.
  const { slug } = useParams<{ slug: string }>();
  if (slug === undefined) throw new Error('LayoutDetailPage rendered without a :slug param.');

  const layoutState = useApi((signal) => getLayout(slug, signal), [slug]);
  const layoutJsonState = useApi((signal) => getLayoutJson(slug, signal), [slug]);
  // Meta is used only for the layoutRevision warning below — its own
  // failure is not this page's failure, so it gets no error branch here.
  const metaState = useApi((signal) => getMeta(signal), []);
  // Read before the early returns below — hooks cannot be called conditionally,
  // and resolving the URL needs `layout.files`, which only exists after them.
  const previewSource = usePreviewSource();
  const { accessToken, user } = useAuth();
  const [sharing, setSharing] = useState(false);
  const [shareResult, setShareResult] = useState<string | null>(null);
  const [shareError, setShareError] = useState<ApiError | null>(null);

  if (layoutState.status === 'loading') {
    return <p className="text-muted">Loading…</p>;
  }

  if (layoutState.status === 'error') {
    return <ErrorNotice error={layoutState.error} />;
  }

  const layout = layoutState.data;
  const currentPinRevision = metaState.status === 'ready' ? metaState.data.pixelAgents.layoutRevision : null;
  const isAheadOfPin = currentPinRevision !== null && layout.layoutRevision > currentPinRevision;
  const jsonState: LayoutJsonState =
    layoutJsonState.status === 'ready'
      ? { status: 'ready', source: layoutJsonState.data }
      : layoutJsonState.status === 'error'
        ? { status: 'error', message: layoutJsonState.error.message }
        : { status: 'loading' };

  async function share() {
    if (!accessToken) return;
    setSharing(true);
    setShareResult(null);
    setShareError(null);
    try {
      const accepted = await shareLayout({ slug: layout.slug }, accessToken);
      setShareResult(
        accepted.deliveriesQueued === 1
          ? 'Shared with 1 subscribed service.'
          : `Shared with ${accepted.deliveriesQueued} subscribed services.`,
      );
    } catch (caught) {
      setShareError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
    } finally {
      setSharing(false);
    }
  }

  return (
    <article>
      <h1 className="font-display text-2xl text-ink">{layout.title}</h1>
      <p className="mt-1 text-muted">
        by <AuthorLink author={layout.author} /> · published{' '}
        {dateFormatter.format(new Date(layout.createdAt))}
      </p>

      {/*
        Both links go to the same editor (#65) and are shown to whoever can
        already submit — a visitor without the capability sees the same page
        they always did, read-only. Saving over this layout stays owner-only,
        which is the API's rule (manage.ts) rather than this page's.
      */}
      {user && (
        <p className="mt-3 flex flex-wrap gap-3 text-sm">
          {user.submission.allowed && user.discordId !== null && user.discordId === layout.author.discordId && (
            <Link
              to={`/layouts/${layout.slug}/edit`}
              className="border-2 border-accent px-3 py-1.5 text-accent"
            >
              Edit layout
            </Link>
          )}
          {user.submission.allowed && (
            <Link
              to={`/editor?from=${encodeURIComponent(layout.slug)}`}
              className="border-2 border-border px-3 py-1.5 text-ink hover:border-accent"
            >
              Use as a starting point
            </Link>
          )}
          <button
            type="button"
            onClick={() => void share()}
            disabled={sharing}
            className="border-2 border-accent px-3 py-1.5 text-accent disabled:opacity-50"
          >
            {sharing ? 'Sharing…' : 'Share'}
          </button>
        </p>
      )}
      {shareResult && <p className="mt-2 text-sm text-accent" role="status">{shareResult}</p>}
      {shareError && <div className="mt-2"><ErrorNotice error={shareError} /></div>}

      <div className="max-w-3xl">
        <LiveOfficePreview
          layout={layout}
          staticPreview={previewImageProps(previewSource, layout.slug, layout.files.thumbnail)}
        />
      </div>

      {layout.description && <p className="mt-4 text-ink">{layout.description}</p>}

      <div className="mt-4">
        <FactsRow facts={factsFor(layout)} />
      </div>

      {layout.tags.length > 0 && (
        <p className="mt-3 flex flex-wrap gap-1.5">
          {layout.tags.map((tag) => (
            <Link
              key={tag}
              to={`/?tags=${encodeURIComponent(tag)}`}
              className="rounded border border-accent/40 px-2 py-0.5 text-xs text-accent hover:bg-accent-soft"
            >
              {tag}
            </Link>
          ))}
        </p>
      )}

      {isAheadOfPin && (
        <div className="mt-4 rounded-lg border-2 border-warning bg-warning-soft px-4 py-3 text-warning">
          <p className="font-medium">This layout may not import cleanly.</p>
          <p className="mt-1 text-sm text-warning">
            It was made with a newer Pixel Agents (layout revision {layout.layoutRevision}) than this site
            currently validates against (revision {currentPinRevision}). Pixel Agents discards a stored layout
            whose revision is older than yours — if your own install is behind, import may reset it to the
            default office. Update Pixel Agents first if that happens.
          </p>
        </div>
      )}

      <LayoutJsonPanel
        state={jsonState}
        slug={layout.slug}
        downloadPath={layout.files.layout}
      />
      <p className="mt-2 text-sm text-subtle">
        In Pixel Agents: <strong>Layout → Import</strong>.
      </p>

      <dl className="mt-8 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-muted">
        <dt>Pixel Agents version validated against</dt>
        <dd>{layout.pixelAgentsVersion ?? 'unknown'}</dd>
        <dt>Layout revision</dt>
        <dd>{layout.layoutRevision}</dd>
        <dt>Last updated</dt>
        <dd>{dateFormatter.format(new Date(layout.updatedAt))}</dd>
        <dt>SHA-256</dt>
        <dd className="break-all font-mono text-xs">{layout.sha256}</dd>
      </dl>
    </article>
  );
}
