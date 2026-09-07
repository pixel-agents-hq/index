/** Subscriber secret generation and encrypted-at-rest persistence. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const PREFIX = 'whsec_';

function keyBytes(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('Webhook secret encryption key is not 32 bytes.');
  return key;
}

export function generateWebhookSecret(): string {
  return `${PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function webhookSecretHint(secret: string): string {
  return secret.slice(-4);
}

export function encryptWebhookSecret(secret: string, base64Key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keyBytes(base64Key), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptWebhookSecret(encrypted: string, base64Key: string): string {
  const [version, encodedIv, encodedTag, encodedCiphertext] = encrypted.split('.');
  if (version !== VERSION || !encodedIv || !encodedTag || encodedCiphertext === undefined) {
    throw new Error('Unsupported webhook secret ciphertext.');
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    keyBytes(base64Key),
    Buffer.from(encodedIv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
