/**
 * The postMessage vocabulary between the character designer page
 * (`routes/CharacterDesignerPage.tsx`) and the `character-designer.html`
 * frame, where Pixel Agents' own Characters view runs (`DesignerApp.tsx`).
 *
 * A frame for the same reasons as `live-office.html` (`protocol.ts`): vendor
 * sources only compile in this directory's relaxed project, and upstream's
 * Tailwind theme redefines token names the site's own CSS uses.
 *
 * Deliberately free of vendor imports — the strict app project imports it.
 */

export const DESIGNER_CHANNEL = 'pixel-index-character-designer';

/** Page → frame: add this profile to the cast (a copy, under a fresh id) and select it. */
export interface OpenProfileMessage {
  channel: typeof DESIGNER_CHANNEL;
  type: 'open';
  profile: Record<string, unknown>;
}

/**
 * Page → frame: dress the character on the stage as this profile — the look a
 * seed makes (`components/SeedPanel.tsx`). One undo step, and the character
 * keeps its id and name, so a seed restyles it rather than adding to the cast.
 */
export interface WearProfileMessage {
  channel: typeof DESIGNER_CHANNEL;
  type: 'wear';
  profile: Record<string, unknown>;
}

export type DesignerCommand = OpenProfileMessage | WearProfileMessage;

/** Frame → page: the frame is listening. */
export interface DesignerReadyMessage {
  channel: typeof DESIGNER_CHANNEL;
  type: 'ready';
}

/** Frame → page: the character on the stage, as it is now (unsaved edits included). */
export interface DesignerSelectionMessage {
  channel: typeof DESIGNER_CHANNEL;
  type: 'selection';
  profile: Record<string, unknown> | null;
  /**
   * The custom wardrobe items it wears (parts saved from the pixel editor).
   * A character config doesn't carry them — upstream's own Save config
   * doesn't either — so a profile wearing one can't be published as it looks.
   */
  customItems: string[];
}

/** Frame → page: the Characters view's close button. */
export interface DesignerCloseMessage {
  channel: typeof DESIGNER_CHANNEL;
  type: 'close';
}

export type DesignerEvent = DesignerReadyMessage | DesignerSelectionMessage | DesignerCloseMessage;

/** A message on this channel, its fields not yet checked. */
type Unchecked = Record<string, unknown>;

function onChannel(data: unknown): data is Unchecked {
  return typeof data === 'object' && data !== null && (data as Unchecked).channel === DESIGNER_CHANNEL;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function isDesignerCommand(data: unknown): data is DesignerCommand {
  return onChannel(data) && (data.type === 'open' || data.type === 'wear') && isObject(data.profile);
}

export function isDesignerEvent(data: unknown): data is DesignerEvent {
  if (!onChannel(data)) return false;
  switch (data.type) {
    case 'ready':
    case 'close':
      return true;
    case 'selection':
      return (
        (data.profile === null || isObject(data.profile)) &&
        Array.isArray(data.customItems) &&
        data.customItems.every((id: unknown) => typeof id === 'string')
      );
    default:
      return false;
  }
}
