/**
 * The postMessage vocabulary between the soundtracks page and the
 * `radio.html` frame — Pixel Agents' own office radio player, unmodified
 * (`music/MusicPlayer.tsx` with its settings panel: mood, song code; the
 * engine `musicEngine.ts`, `composer.ts`), which plays a published song code.
 *
 * A frame for the same reasons as `live-office.html` (`protocol.ts`): the
 * radio is vendor code, and vendor sources only compile in this directory's
 * relaxed project; upstream's Tailwind theme redefines the site's token
 * names. And a *visible* frame, the player itself, because a browser lets a
 * document start audio only from a click inside that document: the page's
 * Play buttons cue a tune and ask the frame to start it, and when the
 * browser says no (`blocked`) the player's own ▶ always can.
 *
 * Deliberately free of vendor imports — the strict app project imports it.
 */

export const RADIO_CHANNEL = 'pixel-index-radio';

/** Page → frame: name these tunes (each code's composed tune name and key). */
export interface DescribeTunesMessage {
  channel: typeof RADIO_CHANNEL;
  type: 'describe';
  codes: string[];
}

/** Page → frame: put this tune on, and start it if the browser allows. */
export interface PlayTuneMessage {
  channel: typeof RADIO_CHANNEL;
  type: 'play';
  code: string;
}

/** Page → frame: pause. */
export interface PauseTuneMessage {
  channel: typeof RADIO_CHANNEL;
  type: 'pause';
}

/**
 * Page → frame: show the player again. Its settings panel has upstream's own
 * "Hide player" (its note points at Pixel Agents' Settings, which the index
 * doesn't have), so the page offers the way back.
 */
export interface ShowPlayerMessage {
  channel: typeof RADIO_CHANNEL;
  type: 'show';
}

export type RadioCommand = DescribeTunesMessage | PlayTuneMessage | PauseTuneMessage | ShowPlayerMessage;

export interface TuneDescription {
  /** The code as the radio writes it (upper case, the seed as 8 hex digits) — what `state.code` reports while it plays. */
  code: string;
  /** The tune's own name, drawn from its seed by the composer ("Sunny Ledger Jig"). */
  name: string;
  /** "D mixolydian" */
  key: string;
}

/** Frame → page: the frame is listening. */
export interface RadioReadyMessage {
  channel: typeof RADIO_CHANNEL;
  type: 'ready';
}

/** Frame → page: names for the codes asked about, keyed as asked; the ones the radio can't play in `invalid`. */
export interface TunesDescribedMessage {
  channel: typeof RADIO_CHANNEL;
  type: 'described';
  tunes: Record<string, TuneDescription>;
  invalid: string[];
}

/** Frame → page: what's on, after every change. */
export interface RadioStateMessage {
  channel: typeof RADIO_CHANNEL;
  type: 'state';
  /** The tune on the player (canonical song code), playing or not. */
  code: string | null;
  playing: boolean;
  /** The browser refused to start audio without a click in the frame: press its ▶. */
  blocked: boolean;
  /** The player was hidden from its settings panel ("Hide player"). */
  hidden: boolean;
}

/** Frame → page: how tall the player is now (its settings panel opens above it), so the frame fits it. */
export interface RadioSizeMessage {
  channel: typeof RADIO_CHANNEL;
  type: 'size';
  height: number;
}

export type RadioEvent = RadioReadyMessage | TunesDescribedMessage | RadioStateMessage | RadioSizeMessage;

/** A message on this channel, its fields not yet checked. */
type Unchecked = Record<string, unknown>;

function onChannel(data: unknown): data is Unchecked {
  return typeof data === 'object' && data !== null && (data as Unchecked).channel === RADIO_CHANNEL;
}

export function isRadioCommand(data: unknown): data is RadioCommand {
  if (!onChannel(data)) return false;
  const message = data;
  switch (message.type) {
    case 'describe':
      return Array.isArray(message.codes) && message.codes.every((code: unknown) => typeof code === 'string');
    case 'play':
      return typeof message.code === 'string';
    case 'pause':
    case 'show':
      return true;
    default:
      return false;
  }
}

export function isRadioEvent(data: unknown): data is RadioEvent {
  if (!onChannel(data)) return false;
  const message = data;
  switch (message.type) {
    case 'ready':
      return true;
    case 'described':
      return (
        typeof message.tunes === 'object' &&
        message.tunes !== null &&
        Array.isArray(message.invalid) &&
        message.invalid.every((code: unknown) => typeof code === 'string')
      );
    case 'state':
      return (
        typeof message.playing === 'boolean' &&
        typeof message.blocked === 'boolean' &&
        typeof message.hidden === 'boolean'
      );
    case 'size':
      return typeof message.height === 'number' && Number.isFinite(message.height) && message.height >= 0;
    default:
      return false;
  }
}
