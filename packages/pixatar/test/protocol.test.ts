import { describe, expect, it } from 'vitest';

import { fromBase64 } from '../src/bytes.js';
import { VENDOR } from '../src/generated/wardrobe.js';
import { pixatar, seedFromText } from '../src/index.js';
import { handle } from '../src/protocol.js';

/** A response's PNG, decoded (a response without one fails the test). */
function pngOf(response: ReturnType<typeof handle>): Uint8Array {
  expect(response.ok).toBe(true);
  return fromBase64((response as { png?: string }).png ?? '');
}

const OCTOCAT = 'px.ASMByrHtCcOaAj1fXEBDyipVOErZBwFd2AE_HAZdVTbyDX2JAR3X5AldBTX_Cn2IAR3U-gBCXzgIdbQBurY';

describe('the CLI protocol', () => {
  it('draws what the package draws', () => {
    const response = handle({ id: 7, op: 'avatar', seed: 'octocat', scale: 2 });
    expect(response).toMatchObject({ id: 7, ok: true, seed: OCTOCAT, background: '#a896e8', avatarBackground: 'color' });
    expect(pngOf(response)).toEqual(pixatar('octocat').avatarPng({ scale: 2 }));

    expect(pngOf(handle({ op: 'sheet', seed: OCTOCAT }))).toEqual(pixatar(OCTOCAT).sheetPng());
  });

  it('takes the background override and the text flag', () => {
    expect(handle({ op: 'info', seed: 'octocat', background: 'transparent' })).toMatchObject({
      seed: seedFromText('octocat', { background: 'transparent' }),
      avatarBackground: 'transparent',
    });
    expect(handle({ op: 'info', seed: 'px.hello', text: true })).toMatchObject({ ok: true, seed: seedFromText('px.hello') });
    expect(handle({ op: 'info', seed: OCTOCAT })).toMatchObject({ profile: pixatar(OCTOCAT).profile });
  });

  it('says its version', () => {
    expect(handle({ op: 'version' })).toMatchObject({ ok: true, vendor: VENDOR });
    expect(handle({ op: 'version' })).toHaveProperty('version', expect.stringMatching(/^\d+\.\d+\.\d+/));
  });

  it('answers bad requests and bad seeds with errors, never by throwing', () => {
    const code = (request: unknown) => {
      const response = handle(request);
      return response.ok ? null : response.error.code;
    };
    expect(code(null)).toBe('invalid-request');
    expect(code([])).toBe('invalid-request');
    expect(code({ op: 'draw', seed: 'x' })).toBe('invalid-request');
    expect(code({ op: 'avatar' })).toBe('invalid-request');
    expect(code({ op: 'avatar', seed: 'x', scale: '2' })).toBe('invalid-request');
    expect(code({ op: 'avatar', seed: 'x', scale: 0 })).toBe('invalid-request');
    expect(code({ op: 'avatar', seed: 'x', background: 'blue' })).toBe('invalid-request');
    expect(code({ op: 'avatar', seed: 'x', text: 'yes' })).toBe('invalid-request');
    expect(code({ op: 'avatar', seed: 'px.!' })).toBe('invalid-seed');
    expect(handle({ id: 'a', op: 'avatar', seed: 'px.!' })).toMatchObject({ id: 'a', ok: false });
  });
});
