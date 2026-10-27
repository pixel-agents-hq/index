import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { ApiError, apiUrl } from '../api/client';
import { submitCharacterProfile } from '../api/manageClient';
import { useAuth } from '../auth/authState';
import { SubmissionGate } from '../components/SubmissionGate';
import { DESIGNER_CHANNEL, isDesignerEvent } from '../live-office/designerProtocol';

/**
 * Design a character with Pixel Agents' own Characters view, without leaving
 * the index: upstream's view runs unmodified in the `character-designer.html`
 * frame (`live-office/DesignerApp.tsx`), on a cast kept in this browser, and
 * this page publishes the character on its stage as a character profile —
 * the same upload as a config file chosen on /assets/submit.
 *
 * `?from=<assetId>` opens a copy of a published profile to remix.
 */
export function CharacterDesignerPage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const from = searchParams.get('from');

  const frameRef = useRef<HTMLIFrameElement>(null);
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  const [customItems, setCustomItems] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const openFrom = useCallback(async () => {
    if (!from) return;
    try {
      const response = await fetch(apiUrl(`/api/v1/assets/${encodeURIComponent(from)}/profile.json`));
      if (!response.ok) throw new ApiError(response.status, `Couldn't open "${from}" in the designer.`);
      const opened = (await response.json()) as Record<string, unknown>;
      frameRef.current?.contentWindow?.postMessage(
        { channel: DESIGNER_CHANNEL, type: 'open', profile: opened },
        window.location.origin,
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, `Couldn't open "${from}" in the designer.`));
    }
  }, [from]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return;
      if (!isDesignerEvent(event.data)) return;
      const message = event.data;
      if (message.type === 'ready') void openFrom();
      else if (message.type === 'selection') {
        setProfile(message.profile);
        setCustomItems(message.customItems);
      } else void navigate('/assets');
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [openFrom, navigate]);

  const name = typeof profile?.name === 'string' && profile.name.trim() ? profile.name.trim() : 'Character';

  async function publish() {
    if (!accessToken || !profile || customItems.length > 0) return;
    setPublishing(true);
    setError(null);
    try {
      const file = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
      const created = await submitCharacterProfile(file, `${name}.json`, accessToken);
      void navigate(`/assets/${created.assetId}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
      setPublishing(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 font-display text-2xl text-ink">Design a character</h1>
          <p className="m-0 mt-1 max-w-2xl text-sm text-muted">
            Pixel Agents' own Characters view. Your cast is kept in this browser; publish the
            character on the stage to share it as a character profile.
          </p>
        </div>
        <SubmissionGate what="Publishing characters" inline>
          <button
            type="button"
            onClick={() => void publish()}
            disabled={!accessToken || !profile || customItems.length > 0 || publishing}
            className="border-2 border-accent px-4 py-2 text-sm text-accent hover:bg-accent hover:text-accent-solid-ink disabled:opacity-50"
          >
            {publishing ? 'Publishing…' : `Publish “${name}”`}
          </button>
        </SubmissionGate>
      </div>

      {customItems.length > 0 && (
        <p role="status" className="m-0 text-sm text-warning">
          {name} wears a custom item made in the pixel editor ({customItems.join(', ')}). A character
          config doesn't carry custom items, so it can't be published looking like this yet: swap it
          for a wardrobe part to publish.
        </p>
      )}
      {error && (
        <div role="alert" className="rounded-lg border-2 border-danger bg-danger-soft px-4 py-3 text-danger">
          <p className="m-0 font-medium">{error.message}</p>
          {error.issues?.map((issue, i) => (
            <p key={i} className="m-0 mt-1 text-sm">
              {issue.message}
            </p>
          ))}
        </div>
      )}

      <iframe
        ref={frameRef}
        src={`${import.meta.env.BASE_URL}character-designer.html`}
        title="Character designer"
        className="block h-[calc(100vh-12rem)] min-h-[560px] w-full border-2 border-border"
      />
    </div>
  );
}
