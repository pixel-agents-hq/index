import { useCallback, useEffect, useRef, useState } from 'react';

import {
  isRadioEvent,
  RADIO_CHANNEL,
  type RadioCommand,
  type TuneDescription,
} from '../live-office/radioProtocol';

export interface OfficeRadioState {
  /** The tune on, as a canonical song code; null until something is cued. */
  code: string | null;
  playing: boolean;
  /** The browser wants a click in the player itself before it plays. */
  blocked: boolean;
}

export interface OfficeRadio {
  state: OfficeRadioState;
  /** Each asked-about code's tune name and key, as Pixel Agents' composer writes them. */
  tunes: Record<string, TuneDescription>;
  play: (code: string) => void;
  pause: () => void;
  /** The player bar: render it once, where it should show. */
  frame: React.ReactElement;
}

/**
 * Pixel Agents' own office radio for this page, in the `radio.html` frame
 * (`live-office/radioProtocol.ts` has why it's a frame, and a visible one).
 * `codes` are named as soon as the frame is listening.
 */
export function useOfficeRadio(codes: readonly string[]): OfficeRadio {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<OfficeRadioState>({ code: null, playing: false, blocked: false });
  const [tunes, setTunes] = useState<Record<string, TuneDescription>>({});

  const send = useCallback((command: RadioCommand) => {
    frameRef.current?.contentWindow?.postMessage(command, window.location.origin);
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return;
      if (!isRadioEvent(event.data)) return;
      const message = event.data;
      if (message.type === 'ready') setReady(true);
      else if (message.type === 'described') setTunes((known) => ({ ...known, ...message.tunes }));
      else setState({ code: message.code, playing: message.playing, blocked: message.blocked });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const key = codes.join(',');
  useEffect(() => {
    if (ready && key) send({ channel: RADIO_CHANNEL, type: 'describe', codes: key.split(',') });
  }, [ready, key, send]);

  const frame = (
    <iframe
      ref={frameRef}
      src={`${import.meta.env.BASE_URL}radio.html`}
      title="Office radio"
      allow="autoplay"
      className="block h-14 w-full border-0"
    />
  );

  return {
    state,
    tunes,
    play: (code) => send({ channel: RADIO_CHANNEL, type: 'play', code }),
    pause: () => send({ channel: RADIO_CHANNEL, type: 'pause' }),
    frame,
  };
}
