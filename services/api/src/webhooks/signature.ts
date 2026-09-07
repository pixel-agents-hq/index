/** The versioned wire signature shared by delivery and third-party receivers. */
import { createHmac } from 'node:crypto';

export const WEBHOOK_TIMESTAMP_HEADER = 'x-pixel-index-timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'x-pixel-index-signature';
export const WEBHOOK_EVENT_ID_HEADER = 'x-pixel-index-event-id';
export const WEBHOOK_SIGNATURE_VERSION = 'v1';
export const WEBHOOK_REPLAY_WINDOW_SECONDS = 5 * 60;

/** ASCII timestamp, a dot, then the exact UTF-8 JSON bytes sent on the wire. */
export function webhookSignedBytes(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** Lowercase hex keeps signatures easy to inspect and constant-width. */
export function signWebhookBody(secret: string, timestamp: string, rawBody: string): string {
  const digest = createHmac('sha256', secret)
    .update(webhookSignedBytes(timestamp, rawBody), 'utf8')
    .digest('hex');
  return `${WEBHOOK_SIGNATURE_VERSION}=${digest}`;
}
