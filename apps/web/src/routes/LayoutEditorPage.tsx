import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { ApiError, getAsset, getLayout, getMeta } from '../api/client';
import { previewCheck, replaceLayoutContent } from '../api/manageClient';
import type { AssetDetail, LayoutDetail } from '../api/types';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/authState';
import { ErrorNotice } from '../components/ErrorNotice';
import { SubmissionGate } from '../components/SubmissionGate';
import {
  type EditOfficeMessage,
  isViewerMessage,
  LIVE_OFFICE_CHANNEL,
} from '../live-office/protocol';
import type { SubmitPageState } from './SubmitPage';

/**
 * Editing a layout inside Pixel Index (#65).
 *
 * One page for every way in, because they differ only in where the first
 * layout comes from:
 *
 * - `/editor` — a blank room from upstream's `createDefaultLayout()`.
 * - `/editor?from=<slug>` — a published layout as the starting point.
 * - `/editor?asset=<assetId>` — a blank room plus exactly one extra custom
 *   asset (#121), for inspecting it in isolation. Publishing/saving are
 *   unavailable here, not merely hidden — see `assetId` below.
 * - `/editor` + the file picker below — someone's own `layout.json`.
 * - `/layouts/<slug>/edit` — that layout, saved back over itself.
 *
 * The office itself lives in the `live-office.html` frame, which is where the
 * upstream editor and its Tailwind theme can run without repainting the rest
 * of the site — see `live-office/protocol.ts`. This page owns everything the
 * frame cannot know about: who is allowed to edit, which layout to load, and
 * where the result goes.
 *
 * Replacing an existing layout is owner-only, matching the API
 * (`PUT /api/v1/layouts/:slug/layout` in services/api/src/layouts/manage.ts).
 * #65 also asks for moderators to be able to edit any layout; that is a
 * deliberate, documented "no" on the API side today (a moderator hides or
 * removes a layout rather than rewriting someone else's design), so it is not
 * something this page can grant by showing a button — it needs the API's own
 * decision first, and is tracked separately.
 */
export function LayoutEditorPage() {
  const { slug } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { accessToken, user } = useAuth();

  // A route param means "save back over this one"; `?from=` means "start from
  // a copy of it". Both load the same way — the difference is only what the
  // button at the bottom of the page does.
  const from = searchParams.get('from');
  const source = slug ?? from;
  const replacing = slug !== undefined;
  // `?asset=` (#121) is deliberately ignored when a `:slug` route param is
  // present — "replace this published layout" and "inspect one asset in
  // isolation" isn't a supported combination.
  const assetId = replacing ? null : searchParams.get('asset');

  const sourceState = useApi(
    (signal) => (source ? getLayout(source, signal) : Promise.resolve<LayoutDetail | null>(null)),
    [source],
  );
  // The revision the API will validate against, which the frame stamps onto
  // whatever it emits — see `EditOfficeMessage.layoutRevision` for why a
  // layout drawn here needs one at all.
  const metaState = useApi((signal) => getMeta(signal), []);
  // Just the asset's display name (any kind, any source — #121's built-in
  // symmetry decision) — the frame itself resolves the actual asset data via
  // its own narrower fetch, keyed off the iframe's own URL (see the `src`
  // below).
  const assetState = useApi(
    (signal) => (assetId ? getAsset(assetId, signal) : Promise.resolve<AssetDetail | null>(null)),
    [assetId],
  );

  const frame = useRef<HTMLIFrameElement>(null);
  const [frameStatus, setFrameStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [frameError, setFrameError] = useState('');
  /** The current layout, as the bytes that would be published. Only the frame produces these. */
  const [raw, setRaw] = useState<string | null>(null);
  /**
   * The first bytes the frame sent — the layout as it was opened. Compared
   * against `raw` to decide whether there is anything to save, which is a
   * question the frame cannot answer alone: importing a file replaces the
   * layout wholesale and leaves the editor's own undo history empty, and that
   * is still very much a change.
   */
  const [openedWith, setOpenedWith] = useState<string | null>(null);
  /**
   * An imported layout, with a counter so that importing the same file twice —
   * or re-importing after editing — still counts as a new request to the frame.
   */
  const [imported, setImported] = useState<{ layout: unknown; nonce: number } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const previewObjectUrl = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (previewObjectUrl.current) URL.revokeObjectURL(previewObjectUrl.current);
    },
    [],
  );

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin) {
        return;
      }
      const message: unknown = event.data;
      if (!isViewerMessage(message)) return;
      if (message.type === 'ready') {
        setFrameStatus('ready');
      } else if (message.type === 'error') {
        setFrameError(message.message);
        setFrameStatus('error');
      } else if (message.type === 'layout') {
        setOpenedWith((first) => first ?? message.layout);
        setRaw(message.layout);
        // The rendered preview belongs to bytes that no longer exist.
        setPreviewUrl(null);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  // The layout to start from, once the source layout (if any) has loaded.
  // `null` is a real value here — it is what asks the frame for a blank room —
  // so this waits for `ready`, never for a truthy payload. An import wins over
  // it, and `undefined` means "nothing to send yet".
  const sourceLayout = sourceState.status === 'ready' ? (sourceState.data?.layout ?? null) : undefined;
  const seed = useMemo(
    () => imported ?? (sourceLayout === undefined ? null : { layout: sourceLayout, nonce: 0 }),
    [imported, sourceLayout],
  );

  const layoutRevision =
    metaState.status === 'ready' ? metaState.data.pixelAgents.layoutRevision : undefined;

  useEffect(() => {
    if (frameStatus !== 'ready' || !seed || layoutRevision === undefined) return;
    const message: EditOfficeMessage = {
      channel: LIVE_OFFICE_CHANNEL,
      type: 'edit',
      layout: seed.layout,
      layoutRevision,
    };
    frame.current?.contentWindow?.postMessage(message, window.location.origin);
  }, [frameStatus, seed, layoutRevision]);

  function onFileChosen(file: File) {
    file
      .text()
      .then((text) => {
        // Parsed here only to fail fast on something that is not JSON at all.
        // Everything else — the shape, the grid, the furniture ids — is checked
        // by the frame (live-office/inboundLayout.ts) and, authoritatively, by
        // the API on preview or publish.
        const parsed: unknown = JSON.parse(text);
        setError(null);
        setImported((current) => ({ layout: parsed, nonce: (current?.nonce ?? 0) + 1 }));
      })
      .catch(() => setError(new ApiError(0, 'That file is not valid JSON.')));
  }

  async function checkPreview() {
    if (!raw) return;
    setChecking(true);
    setError(null);
    try {
      // `accessToken ?? undefined`: previewCheck's own auth is optional
      // (#85) — an anonymous visitor on the create path still gets a real
      // preview, just passing no token at all rather than a null one.
      const blob = await previewCheck(raw, accessToken ?? undefined);
      if (previewObjectUrl.current) URL.revokeObjectURL(previewObjectUrl.current);
      const url = URL.createObjectURL(blob);
      previewObjectUrl.current = url;
      setPreviewUrl(url);
    } catch (caught) {
      setPreviewUrl(null);
      setError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
    } finally {
      setChecking(false);
    }
  }

  async function save() {
    if (!accessToken || !raw || !slug) return;
    setSaving(true);
    setError(null);
    try {
      await replaceLayoutContent(slug, raw, accessToken);
      // `void`: navigate() returns a promise in react-router 7, and there is
      // nothing to do after it resolves — but it must not be left floating.
      void navigate(`/layouts/${slug}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
    } finally {
      setSaving(false);
    }
  }

  function goToSubmit() {
    if (!raw) return;
    const state: SubmitPageState = { raw };
    void navigate('/submit', { state });
  }

  const assetMode = assetId !== null;
  const assetName = assetState.status === 'ready' ? (assetState.data?.name ?? null) : null;
  const heading = assetMode ? `Try “${assetName ?? '…'}”` : replacing ? 'Edit layout' : 'New layout';
  const changed = raw !== null && raw !== openedWith;
  // Ownership by Discord id, the only identifier the public layout carries
  // (#62). UI only: the API decides, and rejects a replacement from anyone
  // else with a 403 whatever this shows.
  const owned =
    sourceState.status !== 'ready' ||
    sourceState.data === null ||
    (Boolean(user?.discordId) && user?.discordId === sourceState.data.author.discordId);
  // Whether the create path's "Continue to publish" hand-off will succeed —
  // the one action still gated behind Discord community membership. `false`
  // while auth is still resolving (`user` is null then), same as logged-out.
  // Check preview is deliberately NOT gated on this: `POST
  // /layouts/preview-check` doesn't persist anything or need membership
  // either, so it works the same whether this is true or not (#85).
  const canSubmit = Boolean(user?.submission.allowed);

  const actionRow = (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => void checkPreview()}
        disabled={!raw || checking}
        className="border-2 border-border px-4 py-2 text-sm text-ink hover:border-accent disabled:opacity-50"
      >
        {checking ? 'Rendering…' : 'Check preview'}
      </button>
      {replacing ? (
        <button
          type="button"
          onClick={() => void save()}
          disabled={!raw || !changed || saving}
          className="border-2 border-accent px-4 py-2 text-sm text-accent hover:bg-accent hover:text-accent-solid-ink disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      ) : (
        // Asset mode (#121) is inspection-only: no "Continue to publish"
        // anywhere in the tree, not merely disabled — there is genuinely no
        // way to reach `goToSubmit` from this page in this mode.
        !assetMode && (
          <button
            type="button"
            onClick={goToSubmit}
            disabled={!raw || !canSubmit}
            className="border-2 border-accent px-4 py-2 text-sm text-accent hover:bg-accent hover:text-accent-solid-ink disabled:opacity-50"
          >
            Continue to publish
          </button>
        )
      )}
      <label className="text-sm text-muted">
        <span className="mr-2">or import a layout.json</span>
        <input
          type="file"
          accept="application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onFileChosen(file);
          }}
          className="text-xs text-muted"
        />
      </label>
    </div>
  );

  // Drawing, importing, and checking a preview are all usable while logged
  // out on the create path (#85) — none of them persists anything or needs
  // Discord community membership. Only "Continue to publish" is gated.
  // Saving over an existing layout is different: it needs a real owner
  // identity to mean anything (see `owned` above), so that path keeps the
  // original full-page gate, unchanged.
  const body = (
    <>
      <p className="mt-1 text-sm text-muted">
        {assetMode
          ? 'A sandbox office for trying this asset out. Nothing here can be saved or published.'
          : replacing
            ? 'Changes replace this layout’s content when you save. Its title, description and tags are edited from My layouts.'
            : 'Draw an office, then continue to publishing. Nothing is saved until you do.'}
      </p>

      {replacing && !owned && (
        <p className="mt-3 text-warning">
          This layout belongs to someone else — only its owner can save changes to it.
        </p>
      )}

      <div
        className="relative mt-4 overflow-hidden border-2 border-border bg-[#181828]"
        style={{ height: 'min(70vh, 720px)' }}
      >
        <iframe
          ref={frame}
          src={`${import.meta.env.BASE_URL}live-office.html${assetId ? `?asset=${encodeURIComponent(assetId)}` : ''}`}
          title="Pixel Agents office editor"
          className="h-full w-full border-0"
        />
        {frameStatus === 'loading' && (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#181828] text-sm text-white/70">
            Loading the editor…
          </p>
        )}
        {frameStatus === 'error' && (
          <p
            role="alert"
            className="absolute inset-0 flex items-center justify-center bg-[#181828] p-6 text-center text-sm text-white/80"
          >
            {frameError || 'The editor could not be loaded.'}
          </p>
        )}
      </div>

      <p className="mt-2 text-xs text-subtle">
        Scroll to pan, Ctrl+scroll to zoom. Ctrl+Z undoes, R rotates the selected item,
        Delete removes it.
      </p>

      {replacing || assetMode ? (
        actionRow
      ) : (
        <SubmissionGate what="Publishing a layout" inline>
          {actionRow}
        </SubmissionGate>
      )}

      {!replacing && !assetMode && (
        <p className="mt-2 text-xs text-subtle">
          Already have a layout.json?{' '}
          <Link to="/submit" className="text-accent underline">
            Publish it directly
          </Link>{' '}
          without opening the editor.
        </p>
      )}

      {error && (
        <div className="mt-4 rounded-lg border-2 border-danger bg-danger-soft px-4 py-3 text-danger">
          <p className="font-medium">{error.message}</p>
          {error.issues && (
            <ul className="mt-2 list-disc pl-5 text-sm text-danger">
              {error.issues.map((issue, i) => (
                <li key={i}>
                  <code className="text-xs">{issue.path}</code>: {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {previewUrl && (
        <div className="mt-4 inline-block bg-canvas p-3">
          <img
            src={previewUrl}
            alt="Preview of your layout"
            className="max-w-full [image-rendering:pixelated]"
          />
        </div>
      )}
    </>
  );

  const content =
    sourceState.status === 'error' ? (
      <ErrorNotice error={sourceState.error} />
    ) : metaState.status === 'error' ? (
      <ErrorNotice error={metaState.error} />
    ) : assetState.status === 'error' ? (
      <ErrorNotice error={assetState.error} />
    ) : (
      body
    );

  return (
    <div>
      <h1 className="font-display text-2xl text-ink">{heading}</h1>
      {replacing ? <SubmissionGate what="The layout editor">{content}</SubmissionGate> : content}
    </div>
  );
}
