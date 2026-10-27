import type { ClientMessage } from '../../../../vendor/pixel-agents/core/src/messages.js';
import type {
  MessageTransport,
  TransportState,
} from '../../../../vendor/pixel-agents/webview-ui/src/transport/types.js';

/**
 * The embedded office is a local demo, not a Pixel Agents standalone server.
 * Upstream's browser transport would otherwise retry `/ws` forever. Vite
 * aliases upstream imports of it to this transport instead.
 *
 * Inert unless a frame asks otherwise: the live preview and the layout editor
 * never do — nothing listens to what they send. The character designer
 * (`DesignerApp.tsx`) is the one frame that plays the server's part for a
 * message, through `setSendHandler`: upstream's Characters view saves its
 * cast over the transport, and that frame keeps it in the browser instead.
 */
class PreviewTransport implements MessageTransport {
  readonly state: TransportState = 'connected';
  readonly ready = Promise.resolve();
  private handler: ((message: ClientMessage) => void) | null = null;

  /** Who answers what upstream sends; null (the default) sends it nowhere. */
  setSendHandler(handler: ((message: ClientMessage) => void) | null): void {
    this.handler = handler;
  }

  send(message: ClientMessage): void {
    this.handler?.(message);
  }

  onMessage(): () => void {
    // The returned value is an unsubscribe function upstream will call on
    // teardown, so it has to be callable — and, since nothing was subscribed,
    // has to do nothing. A frame that answers a message (the designer) hands
    // the answer to its store directly, never through here.
    return () => {
      // Nothing was subscribed.
    };
  }

  onStateChange(): () => void {
    // `state` is a readonly 'connected' above, so it never changes and no
    // listener would ever fire. Same unsubscribe contract as onMessage.
    return () => {
      // Nothing was subscribed.
    };
  }

  dispose(): void {
    // No socket, no timer, no listener: nothing to release.
  }
}

export const transport = new PreviewTransport();
export type { MessageTransport } from '../../../../vendor/pixel-agents/webview-ui/src/transport/types.js';
