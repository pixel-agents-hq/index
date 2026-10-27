import { useCallback, useEffect, useRef, useState } from 'react';

import {
  isRadioEvent,
  RADIO_CHANNEL,
  type RadioCommand,
  type TuneDescription,
} from '../live-office/radioProtocol';

/** Pixel Agents' player is 364px wide, 10px in from the right; the rest is room for its shadow. */
const FRAME_WIDTH_PX = 384;
/** Until the frame reports the player's height: about one player bar. */
const INITIAL_FRAME_HEIGHT_PX = 80;

export interface OfficeRadioState {
  /** The tune on, as a canonical song code; null until something is cued. */
  code: string | null;
  playing: boolean;
  /** The browser wants a click in the player itself before it plays. */
  blocked: boolean;
  /** Hidden from its settings panel; `show()` brings it back. */
  hidden: boolean;
}

export interface OfficeRadio {
  state: OfficeRadioState;
  /** Each asked-about code's tune name and key, as Pixel Agents' composer writes them. */
  tunes: Record<string, TuneDescription>;
  /** Asked-about codes Pixel Agents' radio can't play. */
  invalid: ReadonlySet<string>;
  play: (code: string) => void;
  pause: () => void;
  show: () => void;
  /** Pixel Agents' radio player: render it once; it pins itself to the page's bottom-right corner. */
  frame: React.ReactElement;
}

/**
 * Pixel Agents' own office radio player for this page, unmodified, in the
 * `radio.html` frame (`live-office/radioProtocol.ts` has why it's a frame,
 * and a visible one).
 * `codes` are named as soon as the frame is listening.
 */
export function useOfficeRadio(codes: readonly string[]): OfficeRadio {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<OfficeRadioState>({ code: null, playing: false, blocked: false, hidden: false });
  const [tunes, setTunes] = useState<Record<string, TuneDescription>>({});
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  // The player's height, as the frame reports it (its settings panel opens above it).
  const [height, setHeight] = useState(INITIAL_FRAME_HEIGHT_PX);

  const send = useCallback((command: RadioCommand) => {
    frameRef.current?.contentWindow?.postMessage(command, window.location.origin);
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return;
      if (!isRadioEvent(event.data)) return;
      const message = event.data;
      if (message.type === 'ready') setReady(true);
      else if (message.type === 'described') {
        setTunes((known) => ({ ...known, ...message.tunes }));
        setInvalid((known) => new Set([...known, ...message.invalid]));
      }
      else if (message.type === 'size') setHeight(message.height);
      else setState({ code: message.code, playing: message.playing, blocked: message.blocked, hidden: message.hidden });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Each code asked about once: a list that grows (a typed code, a loaded page) asks only for the new ones.
  const asked = useRef(new Set<string>());
  const key = codes.join('\n');
  useEffect(() => {
    if (!ready) return;
    const fresh = key.split('\n').filter((code) => code && !asked.current.has(code));
    if (fresh.length === 0) return;
    for (const code of fresh) asked.current.add(code);
    send({ channel: RADIO_CHANNEL, type: 'describe', codes: fresh });
  }, [ready, key, send]);

  // Transparent and only as big as the player, so the page stays clickable around it.
  const frame = (
    <iframe
      ref={frameRef}
      src={`${import.meta.env.BASE_URL}radio.html`}
      title="Office radio"
      allow="autoplay"
      className="fixed bottom-0 right-0 z-20 block border-0 bg-transparent"
      style={{ width: `min(100%, ${FRAME_WIDTH_PX}px)`, height }}
    />
  );

  return {
    state,
    tunes,
    invalid,
    play: (code) => send({ channel: RADIO_CHANNEL, type: 'play', code }),
    pause: () => send({ channel: RADIO_CHANNEL, type: 'pause' }),
    show: () => send({ channel: RADIO_CHANNEL, type: 'show' }),
    frame,
  };
}
