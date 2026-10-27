import { useEffect, useState, useSyncExternalStore } from 'react';

import { makeSong } from '../../../../vendor/pixel-agents/webview-ui/src/music/composer.js';
import { officeRadio } from '../../../../vendor/pixel-agents/webview-ui/src/music/musicEngine.js';
import { keyLabel, parseSongCode, songCode } from '../../../../vendor/pixel-agents/webview-ui/src/music/songCode.js';
import {
  isRadioCommand,
  RADIO_CHANNEL,
  type RadioEvent,
  type TuneDescription,
} from './radioProtocol';

/** How long a start may take before it counts as refused (no click in this document yet). */
const START_GRACE_MS = 400;

function post(event: RadioEvent): void {
  window.parent.postMessage(event, window.location.origin);
}

/** A song code's tune as Pixel Agents' own composer writes it; null when the radio can't play the code. */
function describe(code: string): TuneDescription | null {
  const parsed = parseSongCode(code);
  if (!parsed) return null;
  const song = makeSong(parsed.seed, parsed.moodKey, null, parsed.root);
  return { code: songCode(song), name: song.name, key: keyLabel(song) };
}

/**
 * The player bar in `radio.html`: Pixel Agents' office radio, driven by the
 * soundtracks page (`radioProtocol.ts`). Nothing plays until something is
 * cued; after a tune ends the radio plays on as it does in the office.
 */
export function RadioApp() {
  const state = useSyncExternalStore(officeRadio.subscribe, officeRadio.getState);
  const [cued, setCued] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const code = cued ? songCode(state.song) : null;

  useEffect(() => {
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      if (!isRadioCommand(event.data)) return;
      const command = event.data;
      if (command.type === 'describe') {
        const tunes: Record<string, TuneDescription> = {};
        const invalid: string[] = [];
        for (const c of command.codes) {
          const tune = describe(c);
          if (tune) tunes[c] = tune;
          else invalid.push(c);
        }
        post({ channel: RADIO_CHANNEL, type: 'described', tunes, invalid });
      } else if (command.type === 'play') {
        if (!officeRadio.playCode(command.code)) return;
        setCued(true);
        clearTimeout(startTimer);
        startTimer = setTimeout(() => setBlocked(!officeRadio.getState().playing), START_GRACE_MS);
      } else if (officeRadio.getState().playing) {
        void officeRadio.toggle();
      }
    }
    window.addEventListener('message', onMessage);
    post({ channel: RADIO_CHANNEL, type: 'ready' });
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(startTimer);
    };
  }, []);

  // Refused once, until this frame's own ▶ (the click the browser wants) or a tune that plays.
  const refused = blocked && !state.playing;
  useEffect(() => {
    post({ channel: RADIO_CHANNEL, type: 'state', code, playing: state.playing, blocked: refused });
  }, [code, state.playing, refused]);

  return (
    <div className="radio">
      <button
        type="button"
        className="radio-toggle"
        disabled={!cued}
        onClick={() => {
          setBlocked(false);
          void officeRadio.toggle();
        }}
        aria-label={state.playing ? 'Pause' : 'Play'}
      >
        {state.playing ? '❚❚' : '▶'}
      </button>
      <div className="radio-text">
        {cued ? (
          <>
            <span className="radio-name">{state.song.name}</span>
            <span className="radio-meta">
              {keyLabel(state.song)} · <code>{code}</code>
            </span>
          </>
        ) : (
          <span className="radio-meta">Press Play on a soundtrack to hear it on the office radio.</span>
        )}
        {refused && <span className="radio-meta">Your browser wants a click here: press ▶.</span>}
      </div>
    </div>
  );
}
