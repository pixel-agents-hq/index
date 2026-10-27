import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { ApiError, listSoundtracks } from '../api/client';
import { deleteSoundtrack, submitSoundtrack } from '../api/manageClient';
import type { Soundtrack } from '../api/types';
import { useAuth } from '../auth/authState';
import { AuthorLink } from '../components/AuthorLink';
import { ErrorNotice } from '../components/ErrorNotice';
import { useOfficeRadio } from '../components/OfficeRadio';
import { SubmissionGate } from '../components/SubmissionGate';

const PAGE_SIZE = 24;
/** The office radio's moods (services/api's soundtracks/songCode.ts MOOD_KEYS). */
const MOODS = ['town', 'route', 'lab', 'night', 'orbit', 'rain', 'dawn', 'arcade'] as const;
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

const buttonClass =
  'border-2 border-border px-3 py-1.5 text-sm text-ink hover:border-accent disabled:opacity-50';

/**
 * Soundtracks: Pixel Agents office radio tunes, published to showcase a
 * favourite. A tune is its song code — the radio composes it from that — so
 * the code is front and centre with a one-click Copy (paste it into the
 * radio's settings in Pixel Agents), and Play hears it right here on the
 * same radio (`useOfficeRadio`).
 */
export function SoundtracksPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const mood = searchParams.get('mood');
  const author = searchParams.get('author');
  const authorLabel = searchParams.get('authorLabel');

  const [soundtracks, setSoundtracks] = useState<Soundtrack[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  const params = { ...(mood ? { mood } : {}), ...(author ? { author } : {}) };
  const paramsKey = JSON.stringify(params);

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current = controller;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSoundtracks(null);
    setError(null);
    listSoundtracks({ ...(JSON.parse(paramsKey) as object), limit: PAGE_SIZE }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setSoundtracks(response.soundtracks);
        setTotal(response.total);
        setCursor(response.nextCursor);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
      });
    return () => controller.abort();
  }, [paramsKey]);

  function loadMore() {
    if (!cursor) return;
    const signal = requestRef.current?.signal;
    setLoadingMore(true);
    listSoundtracks({ ...params, limit: PAGE_SIZE, cursor }, signal)
      .then((response) => {
        if (signal?.aborted) return;
        setSoundtracks((existing) => [...(existing ?? []), ...response.soundtracks]);
        setCursor(response.nextCursor);
      })
      .catch((caught: unknown) => {
        if (signal?.aborted) return;
        setError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
      })
      .finally(() => {
        if (!signal?.aborted) setLoadingMore(false);
      });
  }

  const radio = useOfficeRadio((soundtracks ?? []).map((s) => s.code));

  function setMood(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('mood', value);
    else next.delete('mood');
    setSearchParams(next);
  }

  function clearAuthor() {
    const next = new URLSearchParams(searchParams);
    next.delete('author');
    next.delete('authorLabel');
    setSearchParams(next);
  }

  return (
    <div className="pb-20">
      <h1 className="font-display text-2xl text-ink">Soundtracks</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Favourite tunes from the Pixel Agents office radio. Every tune is a song code: copy
        one and paste it into the radio's settings in Pixel Agents to play it in your
        office, or press Play to hear it here.
      </p>

      <PublishSoundtrack onPublished={(created) => setSoundtracks((existing) => [created, ...(existing ?? [])])} />

      <div className="mb-6 mt-6 flex flex-wrap items-center gap-3 border-2 border-border bg-surface p-4">
        <label className="flex items-center gap-1.5 text-sm text-muted">
          Mood
          <select
            value={mood ?? ''}
            onChange={(event) => setMood(event.target.value)}
            className="border-2 border-border bg-surface px-2 py-1 text-sm text-ink"
          >
            <option value="">Any</option>
            {MOODS.map((m) => (
              <option key={m} value={m} className="capitalize">
                {m}
              </option>
            ))}
          </select>
        </label>
        {author && (
          <button type="button" onClick={clearAuthor} className={buttonClass}>
            by {authorLabel ?? author} ✕
          </button>
        )}
        {soundtracks && <span className="text-sm text-subtle">{total} soundtracks</span>}
      </div>

      {error && <ErrorNotice error={error} />}
      {!soundtracks && !error && <p className="text-muted">Loading…</p>}
      {soundtracks?.length === 0 && <p className="text-muted">No soundtracks yet.</p>}

      {soundtracks && soundtracks.length > 0 && (
        <ul className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {soundtracks.map((soundtrack) => (
            <SoundtrackCard
              key={soundtrack.id}
              soundtrack={soundtrack}
              tuneName={radio.tunes[soundtrack.code]?.name ?? null}
              tuneKey={radio.tunes[soundtrack.code]?.key ?? null}
              playing={radio.state.playing && radio.state.code === soundtrack.code}
              onPlay={() => radio.play(soundtrack.code)}
              onPause={radio.pause}
              onDeleted={() => setSoundtracks((existing) => existing?.filter((s) => s.id !== soundtrack.id) ?? null)}
            />
          ))}
        </ul>
      )}

      {cursor && (
        <button type="button" onClick={loadMore} disabled={loadingMore} className={`${buttonClass} mt-6`}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}

      <div className="fixed inset-x-0 bottom-0 z-20 border-t-2 border-border bg-surface">{radio.frame}</div>
    </div>
  );
}

function PublishSoundtrack({ onPublished }: { onPublished: (soundtrack: Soundtrack) => void }) {
  const { accessToken } = useAuth();
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function publish() {
    if (!accessToken || !code.trim()) return;
    setPublishing(true);
    setError(null);
    try {
      const created = await submitSoundtrack({ code: code.trim(), ...(title.trim() ? { title: title.trim() } : {}) }, accessToken);
      onPublished(created);
      setCode('');
      setTitle('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <section className="mt-6 max-w-2xl border-2 border-border bg-surface p-4">
      <h2 className="m-0 font-display text-lg text-ink">Publish a soundtrack</h2>
      <SubmissionGate what="Publishing soundtracks" inline>
        <p className="mt-1 text-sm text-muted">
          In Pixel Agents, open the radio's settings and copy the song code of a tune you
          like.
        </p>
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void publish();
          }}
        >
          <label className="flex flex-col gap-1 text-sm text-muted">
            Song code
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="TOWN-5-8F3A21C0"
              className="border-2 border-border bg-canvas px-2 py-1 font-mono text-sm text-ink"
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted">
            Title (optional)
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={80}
              className="border-2 border-border bg-canvas px-2 py-1 text-sm text-ink"
            />
          </label>
          <button
            type="submit"
            disabled={!accessToken || !code.trim() || publishing}
            className="border-2 border-accent px-4 py-1.5 text-sm text-accent hover:bg-accent hover:text-accent-solid-ink disabled:opacity-50"
          >
            {publishing ? 'Publishing…' : 'Publish'}
          </button>
        </form>
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error.issues?.[0]?.message ?? error.message}
          </p>
        )}
      </SubmissionGate>
    </section>
  );
}

function SoundtrackCard({
  soundtrack,
  tuneName,
  tuneKey,
  playing,
  onPlay,
  onPause,
  onDeleted,
}: {
  soundtrack: Soundtrack;
  tuneName: string | null;
  tuneKey: string | null;
  playing: boolean;
  onPlay: () => void;
  onPause: () => void;
  onDeleted: () => void;
}) {
  const { accessToken, user } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deleteError, setDeleteError] = useState<ApiError | null>(null);

  // Same owner-or-moderator rule (and discordId ownership signal) as AssetDetailPage.
  const isOwner = user !== null && user.discordId !== null && user.discordId === soundtrack.author.discordId;
  const isModerator = user?.role === 'moderator' || user?.role === 'admin';
  const canDelete = accessToken !== null && (isOwner || isModerator);

  async function copy() {
    try {
      await navigator.clipboard.writeText(soundtrack.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard (an insecure origin, a denied permission): the code is selectable text right there.
      setCopied(false);
    }
  }

  async function remove() {
    if (!accessToken) return;
    if (!confirm(`Delete "${soundtrack.title ?? soundtrack.code}"?`)) return;
    let reason: string | undefined;
    if (!isOwner) {
      const input = prompt("Reason for deleting this soundtrack (required, since it isn't yours):");
      if (!input) return;
      reason = input;
    }
    try {
      await deleteSoundtrack(soundtrack.id, accessToken, reason);
      onDeleted();
    } catch (caught) {
      setDeleteError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
    }
  }

  return (
    <li className="flex flex-col gap-2 border-2 border-border bg-surface p-4">
      <h2 className="m-0 font-display text-lg text-ink">{soundtrack.title ?? tuneName ?? soundtrack.code}</h2>
      {(tuneName || tuneKey) && (
        <p className="m-0 text-sm text-muted">
          {soundtrack.title && tuneName ? `${tuneName} · ` : ''}
          {tuneKey}
        </p>
      )}
      <div className="flex items-center gap-2">
        <code className="select-all border-2 border-border bg-canvas px-2 py-1 font-mono text-sm text-ink">
          {soundtrack.code}
        </code>
        <button type="button" onClick={() => void copy()} className={buttonClass} aria-live="polite">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="m-0 text-xs capitalize text-subtle">{soundtrack.mood}</p>
      <p className="m-0 text-sm text-muted">
        by <AuthorLink author={soundtrack.author} /> · {dateFormatter.format(new Date(soundtrack.createdAt))}
      </p>
      <div className="mt-auto flex flex-wrap gap-2">
        <button type="button" onClick={playing ? onPause : onPlay} className={buttonClass}>
          {playing ? 'Pause' : 'Play'}
        </button>
        {canDelete && (
          <button type="button" onClick={() => void remove()} className="border-2 border-danger px-3 py-1.5 text-sm text-danger">
            Delete
          </button>
        )}
      </div>
      {deleteError && <ErrorNotice error={deleteError} />}
    </li>
  );
}
