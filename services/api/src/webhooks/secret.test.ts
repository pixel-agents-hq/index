import { describe, expect, it } from 'vitest';

import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateWebhookSecret,
  webhookSecretHint,
} from './secret.js';
import { signWebhookBody, webhookSignedBytes } from './signature.js';

const KEY = Buffer.alloc(32, 4).toString('base64');

describe('webhook secrets', () => {
  it('generates a high-entropy prefixed secret and only exposes a four-character hint', () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(webhookSecretHint(secret)).toBe(secret.slice(-4));
  });

  it('encrypts nondeterministically and decrypts with the deployment key', () => {
    const first = encryptWebhookSecret('whsec_example', KEY);
    const second = encryptWebhookSecret('whsec_example', KEY);
    expect(first).not.toBe(second);
    expect(decryptWebhookSecret(first, KEY)).toBe('whsec_example');
    expect(() => decryptWebhookSecret(first, Buffer.alloc(32, 5).toString('base64'))).toThrow();
  });
});

describe('webhook signatures', () => {
  it('signs timestamp-dot-raw-body as lowercase HMAC-SHA256 hex', () => {
    expect(webhookSignedBytes('1723723200', '{"eventId":"one"}')).toBe(
      '1723723200.{"eventId":"one"}',
    );
    expect(signWebhookBody('secret', '1723723200', '{"eventId":"one"}')).toMatch(
      /^v1=[0-9a-f]{64}$/,
    );
    expect(signWebhookBody('secret', '1723723200', '{"eventId":"one"}')).not.toBe(
      signWebhookBody('secret', '1723723201', '{"eventId":"one"}'),
    );
  });
});
