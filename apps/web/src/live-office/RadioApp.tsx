import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { MUSIC_PLAYER_BOTTOM_PX } from '../../../../vendor/pixel-agents/webview-ui/src/constants.js';
import { makeSong } from '../../../../vendor/pixel-agents/webview-ui/src/music/composer.js';
import { officeRadio } from '../../../../vendor/pixel-agents/webview-ui/src/music/musicEngine.js';
import { MusicPlayer } from '../../../../vendor/pixel-agents/webview-ui/src/music/MusicPlayer.js';
import { keyLabel, parseSongCode, songCode } from '../../../../vendor/pixel-agents/webview-ui/src/music/songCode.js';
import {
  isRadioCommand,
  RADIO_CHANNEL,
  type RadioEvent,
  type TuneDescription,
} from './radioProtocol';

/** How long a start may take before it counts as refused (no click in this document yet). */
const START_GRACE_MS = 400;
/** Room kept above the player, so its top border and shadow aren't clipped by the frame's edge. */
const TOP_MARGIN_PX = 10;

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
 * `radio.html`: Pixel Agents' own office radio player, unmodified — play,
 * skip, volume, the visualizer and its settings panel (mood, and the song
 * code to copy or play) — driven by the soundtracks page as well
 * (`radioProtocol.ts`). After a tune ends the radio plays on, as it does in
 * the office.
 */
export function RadioApp() {
  const state = useSyncExternalStore(officeRadio.subscribe, officeRadio.getState);
  const [blocked, setBlocked] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const code = songCode(state.song);

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
      } else if (command.type === 'show') {
        officeRadio.setHidden(false);
      } else if (command.type === 'play') {
        // Playing a soundtrack brings a hidden player back: it's where the tune is.
        if (!parseSongCode(command.code)) return;
        officeRadio.setHidden(false);
        officeRadio.playCode(command.code);
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

  // Refused once, until a tune plays (the player's own ▶ is the click the browser wants).
  const refused = blocked && !state.playing;
  useEffect(() => {
    post({ channel: RADIO_CHANNEL, type: 'state', code, playing: state.playing, blocked: refused, hidden: state.hidden });
  }, [code, state.playing, refused, state.hidden]);

  // The player sits MUSIC_PLAYER_BOTTOM_PX above the frame's foot and grows
  // upwards (its settings panel opens above it), so the page sizes the frame
  // to it: its height, that gap below, a margin above.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const sizes = new ResizeObserver(() => {
      const player = box.firstElementChild;
      const height = player instanceof HTMLElement ? player.offsetHeight : 0;
      post({ channel: RADIO_CHANNEL, type: 'size', height: height + MUSIC_PLAYER_BOTTOM_PX + TOP_MARGIN_PX });
    });
    // The player's root is replaced when it hides or shows; follow whichever is there.
    const follow = () => {
      sizes.disconnect();
      if (box.firstElementChild) sizes.observe(box.firstElementChild);
      // Hidden: nothing to show, so the frame takes no room at all.
      else post({ channel: RADIO_CHANNEL, type: 'size', height: 0 });
    };
    const children = new MutationObserver(follow);
    children.observe(box, { childList: true });
    follow();
    return () => {
      sizes.disconnect();
      children.disconnect();
    };
  }, []);

  return (
    <>
      <div ref={boxRef} className="radio-box">
        <MusicPlayer mobile={false} />
      </div>
      {refused && <p className="radio-hint">Your browser wants a click on the player: press ▶.</p>}
    </>
  );
}
