import {
  type AvatarBackground,
  type CharacterProfile,
  type Direction,
  encodePng,
  PixatarError,
  randomSeed,
  renderAvatar,
  renderFrame,
  renderSheet,
  type RgbaImage,
  SHEET_FRAMES,
  TYPE_FRAME_DURATION_SEC,
  WALK_FRAME_DURATION_SEC,
} from '@pixel-index/pixatar';
import { type SyntheticEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { codeOf, latest, lookOf, readSeed, searchOf, seedFromSearch, type SeedKind, type TypedSeed } from './seeds';

const buttonClass =
  'border-2 border-border px-3 py-1.5 text-sm text-ink hover:border-accent disabled:opacity-50';

/** How long typed text waits for the next keystroke before it makes its character. */
const TYPING_DELAY = 150;

const PLACEHOLDERS: Record<SeedKind, string> = {
  text: 'Type anything (a name, an email): the same text, the same character',
  code: 'Paste a px. seed code',
};

const AVATAR_SCALES = [1, 4, 8, 16] as const;
type AvatarScale = (typeof AVATAR_SCALES)[number];

/** Paint an image onto a canvas, sizing the canvas to it. */
function paint(canvas: HTMLCanvasElement | null, image: RgbaImage): void {
  const context = canvas?.getContext('2d');
  if (!canvas || !context) return;
  canvas.width = image.width;
  canvas.height = image.height;
  context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
}

/** Offer bytes as a file download. */
function download(fileName: string, data: Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A transparent avatar sits on a checkerboard, so it reads as transparent. */
const CHECKERBOARD = {
  backgroundImage: 'repeating-conic-gradient(#0000 0 25%, #8884 0 50%)',
  backgroundSize: '16px 16px',
};

function Avatar({ profile, background }: { profile: CharacterProfile; background: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => paint(ref.current, renderAvatar(profile, { scale: 6, background })), [profile, background]);
  return (
    <canvas
      ref={ref}
      aria-label="Avatar"
      className="block border-2 border-border [image-rendering:pixelated]"
      style={background ? undefined : CHECKERBOARD}
    />
  );
}

type Action = 'walk' | 'type' | 'read';
const ACTIONS: readonly Action[] = ['walk', 'type', 'read'];
const DIRECTIONS: readonly Direction[] = ['down', 'left', 'up', 'right'];
const SECONDS: Record<Action, number> = {
  walk: WALK_FRAME_DURATION_SEC,
  type: TYPE_FRAME_DURATION_SEC,
  read: TYPE_FRAME_DURATION_SEC,
};

/** The character walking (typing, reading) in every direction, from its own sprite sheet. */
function Animation({ profile, background }: { profile: CharacterProfile; background: string }) {
  const [action, setAction] = useState<Action>('walk');
  const [tick, setTick] = useState(0);
  const cycles = useMemo(
    () =>
      DIRECTIONS.map((direction) =>
        SHEET_FRAMES[action].map((frame) => renderFrame(profile, { direction, frame, scale: 3 })),
      ),
    [profile, action],
  );
  const refs = useRef<(HTMLCanvasElement | null)[]>([]);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), SECONDS[action] * 1000);
    return () => clearInterval(timer);
  }, [action]);

  useEffect(() => {
    cycles.forEach((cycle, i) => {
      const image = cycle.at(tick % cycle.length);
      if (image) paint(refs.current.at(i) ?? null, image);
    });
  }, [cycles, tick]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 border-2 border-border p-2" style={{ background }}>
        {DIRECTIONS.map((direction, i) => (
          <canvas
            key={direction}
            ref={(element) => {
              refs.current[i] = element;
            }}
            aria-label={`Facing ${direction}`}
            className="block [image-rendering:pixelated]"
          />
        ))}
      </div>
      <div className="flex gap-1" role="group" aria-label="Animation">
        {ACTIONS.map((a) => (
          <button
            key={a}
            type="button"
            aria-pressed={a === action}
            onClick={() => setAction(a)}
            className={`${buttonClass} capitalize aria-pressed:border-accent aria-pressed:text-accent`}
          >
            {a}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Seeds in the character designer: free text or a `px.` seed code makes a
 * character (see `seeds.ts` for what each kind promises), dressed on the
 * designer's stage through `onWear`. It works both ways: whatever is on the
 * stage, however it got there, is shown here with its seed code, avatar,
 * animation and downloads, so every edit in the Characters view makes a new
 * seed.
 *
 * `?seed=` / `?text=` in the address is worn once the frame is `ready`
 * (unless the page is remixing a published profile, `?from=`); after a seed
 * has been used here, the address follows the character.
 */
export default function SeedPanel({
  selection,
  ready,
  remixing,
  onWear,
}: {
  /** The character on the designer's stage, unsaved edits included. */
  selection: Record<string, unknown> | null;
  /** The designer frame is listening. */
  ready: boolean;
  /** The page is opening a published profile (`?from=`), which wins over an address seed. */
  remixing: boolean;
  /** Dress the character on the stage as this profile. Keep it stable: typing is debounced through it. */
  onWear: (profile: CharacterProfile) => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  // The address's seed, read once: what it makes, or why it makes nothing.
  const [start] = useState(() => {
    const seed = remixing ? null : seedFromSearch(searchParams);
    if (!seed) return { seed: null, read: null, error: null };
    try {
      return { seed, read: readSeed(seed), error: null };
    } catch (caught) {
      return { seed: null, read: null, error: caught instanceof PixatarError ? caught.message : String(caught) };
    }
  });
  const initial = start.seed;
  // What the box says, and whether it has been put on the stage yet: until it
  // has, the box keeps it; after, it shows it only while it still makes the
  // character on the stage (otherwise, that character's code).
  const [draft, setDraft] = useState<TypedSeed>(initial ?? { kind: 'text', value: '' });
  const [worn, setWorn] = useState(initial !== null);
  const [avatarBackground, setAvatarBackground] = useState<AvatarBackground>(start.read?.background ?? 'color');
  const [addressed, setAddressed] = useState(initial !== null);
  const [error, setError] = useState<string | null>(start.error);
  const [avatarScale, setAvatarScale] = useState<AvatarScale>(8);
  const [copied, setCopied] = useState<'seed' | 'link' | null>(null);

  const look = useMemo(() => lookOf(selection, avatarBackground), [selection, avatarBackground]);
  const draftMakesLook = look !== null && codeOf(draft, avatarBackground) === look.seed;
  const shown: TypedSeed = !worn || draftMakesLook || !look ? draft : { kind: 'code', value: look.seed };

  // Free text makes its character as it is typed — the latest text only.
  const typing = useMemo(
    () =>
      latest(
        (value: string) => {
          try {
            return readSeed({ kind: 'text', value }).profile;
          } catch {
            return null;
          }
        },
        (made) => {
          if (!made) return;
          setError(null);
          setWorn(true);
          setAddressed(true);
          onWear(made);
        },
        TYPING_DELAY,
      ),
    [onWear],
  );
  useEffect(() => () => typing.cancel(), [typing]);

  // The address's seed, worn once the frame can take it.
  const wornInitial = useRef(false);
  const initialProfile = start.read?.profile ?? null;
  useEffect(() => {
    if (!ready || !initialProfile || wornInitial.current) return;
    wornInitial.current = true;
    onWear(initialProfile);
  }, [ready, initialProfile, onWear]);

  // Once a seed has been used here, the address follows the character: the
  // text while the box's text makes it on a coloured background, else the code.
  let address: TypedSeed | null = null;
  if (addressed && look) {
    const keepText = shown.kind === 'text' && draftMakesLook && avatarBackground === 'color';
    address = keepText ? shown : { kind: 'code', value: look.seed };
  }
  const addressQuery = address ? searchOf(address).toString() : null;
  const currentQuery = searchParams.toString();
  useEffect(() => {
    if (addressQuery !== null && addressQuery !== currentQuery) {
      setSearchParams(new URLSearchParams(addressQuery), { replace: true });
    }
  }, [addressQuery, currentQuery, setSearchParams]);

  function apply(seed: TypedSeed) {
    let read: ReturnType<typeof readSeed>;
    try {
      read = readSeed(seed);
    } catch (caught) {
      setError(caught instanceof PixatarError ? caught.message : String(caught));
      return;
    }
    typing.cancel();
    setError(null);
    setDraft(seed);
    setWorn(true);
    setAddressed(true);
    if (read.background) setAvatarBackground(read.background);
    onWear(read.profile);
  }

  function edit(value: string) {
    setDraft({ kind: shown.kind, value });
    setWorn(false);
    if (shown.kind !== 'text') return;
    if (value) typing.schedule(value);
    else typing.cancel();
  }

  function onSubmit(event: SyntheticEvent) {
    event.preventDefault();
    if (shown.kind === 'code') apply(shown);
    else if (shown.value) typing.flush(shown.value);
  }

  function switchKind(next: SeedKind) {
    if (next === shown.kind) return;
    typing.cancel();
    setError(null);
    // a code to paste over, or a fresh text to type
    setDraft({ kind: next, value: next === 'code' && look ? look.seed : '' });
    setWorn(false);
  }

  async function copy(what: 'seed' | 'link', text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // No clipboard (an insecure origin, a denied permission): the code is selectable text right there.
      setCopied(null);
    }
  }

  const name = (typeof selection?.name === 'string' && selection.name.trim() ? selection.name.trim() : 'character').replace(
    /[^\w.-]+/g,
    '-',
  );

  return (
    <section aria-label="Seed" className="flex flex-col gap-3 border-2 border-border bg-surface p-4">
      <div>
        <h2 className="m-0 font-display text-lg text-ink">Start from a seed</h2>
        <p className="m-0 mt-1 max-w-3xl text-sm text-muted">
          Any text makes a character, like an identicon: the same text, the same character. A seed code is a
          character written down, and keeps it for good. Every change in the designer makes a new seed code.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-wrap items-stretch gap-2">
        <div className="flex" role="group" aria-label="Seed kind">
          {(['text', 'code'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={k === shown.kind}
              onClick={() => switchKind(k)}
              title={k === 'text' ? 'Free text: any string, hashed into a character' : 'A px. seed code: the character itself, exactly'}
              className={`${buttonClass} aria-pressed:border-accent aria-pressed:text-accent`}
            >
              {k === 'text' ? 'Text' : 'Seed code'}
            </button>
          ))}
        </div>
        <label htmlFor="designer-seed" className="sr-only">
          {shown.kind === 'text' ? 'Free-text seed' : 'Seed code'}
        </label>
        <input
          id="designer-seed"
          value={shown.value}
          onChange={(event) => edit(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder={PLACEHOLDERS[shown.kind]}
          className="min-w-60 flex-1 border-2 border-border bg-canvas px-2 py-1 font-mono text-sm text-ink"
        />
        {shown.kind === 'code' && (
          <button type="submit" className="border-2 border-accent px-3 py-1.5 text-sm text-accent hover:bg-accent hover:text-accent-solid-ink">
            Make
          </button>
        )}
        <button
          type="button"
          onClick={() => apply({ kind: 'code', value: randomSeed({ background: avatarBackground }) })}
          title="A new random character"
          className={buttonClass}
        >
          Random
        </button>
      </form>
      {error && (
        <p role="alert" className="m-0 text-sm text-danger">
          {error}
        </p>
      )}

      {look && (
        <div className="flex flex-wrap items-start gap-6">
          <div className="flex flex-col gap-1">
            <Avatar profile={look.profile} background={look.transparent ? null : look.background} />
            <span className="text-xs text-subtle">Background {look.transparent ? 'transparent' : look.background}</span>
          </div>
          <Animation profile={look.profile} background={look.background} />
          <div className="flex min-w-0 flex-1 basis-72 flex-col gap-2">
            <span className="text-sm text-muted">
              {shown.kind === 'text' && draftMakesLook
                ? 'The seed code your text makes: keep it for this exact character'
                : 'Seed code: give it back for this exact character'}
            </span>
            <code data-testid="seed-code" className="block select-all break-all border-2 border-border bg-canvas p-2 font-mono text-xs text-ink">
              {look.seed}
            </code>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void copy('seed', look.seed)} className={buttonClass} aria-live="polite">
                {copied === 'seed' ? 'Copied' : 'Copy seed'}
              </button>
              <button type="button" onClick={() => void copy('link', window.location.href)} className={buttonClass} aria-live="polite">
                {copied === 'link' ? 'Copied' : 'Copy link'}
              </button>
              <label
                className="flex items-center gap-1 text-sm text-ink"
                title="Saved in the seed code. The sprite sheet is always transparent."
              >
                <input
                  type="checkbox"
                  checked={look.transparent}
                  onChange={(event) => {
                    setAvatarBackground(event.target.checked ? 'transparent' : 'color');
                    setAddressed(true);
                  }}
                />
                Transparent avatar
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  download(
                    `${name}-avatar.png`,
                    encodePng(
                      renderAvatar(look.profile, { scale: avatarScale, background: look.transparent ? null : look.background }),
                    ),
                    'image/png',
                  )
                }
                className={buttonClass}
              >
                Avatar PNG
              </button>
              <select
                aria-label="Avatar size"
                value={avatarScale}
                onChange={(event) => setAvatarScale(Number(event.target.value) as AvatarScale)}
                className="border-2 border-border bg-canvas px-1 py-1 text-sm text-ink"
              >
                {AVATAR_SCALES.map((scale) => (
                  <option key={scale} value={scale}>
                    {20 * scale}px
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => download(`${name}-sheet.png`, encodePng(renderSheet(look.profile)), 'image/png')}
                className={buttonClass}
              >
                Sprite sheet PNG
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
