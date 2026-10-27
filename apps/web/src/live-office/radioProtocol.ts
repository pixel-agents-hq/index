/**
 * The postMessage vocabulary between the soundtracks page and the
 * `radio.html` frame — the player bar where Pixel Agents' own office radio
 * (`music/musicEngine.ts`, `composer.ts`) plays a published song code.
 *
 * A frame for the same reason as `live-office.html` (`protocol.ts`): the
 * radio is vendor code, and vendor sources only compile in this directory's
 * relaxed project. And a *visible* frame with its own ▶, because a browser
 * lets a document start audio only from a click inside that document: the
 * page's Play buttons cue a tune and ask the frame to start it, and when the
 * browser says no (`blocked`) the frame's own ▶ always can.
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

export type RadioCommand = DescribeTunesMessage | PlayTuneMessage | PauseTuneMessage;

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
  /** The tune on (canonical song code), or null before anything was cued. */
  code: string | null;
  playing: boolean;
  /** The browser refused to start audio without a click in the frame: press its ▶. */
  blocked: boolean;
}

export type RadioEvent = RadioReadyMessage | TunesDescribedMessage | RadioStateMessage;

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
      return typeof message.playing === 'boolean' && typeof message.blocked === 'boolean';
    default:
      return false;
  }
}
