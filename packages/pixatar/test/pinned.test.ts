/**
 * Known seeds pinned to what they make today, as literals rather than snapshots, so they
 * can't be re-pinned by `vitest -u` without someone noticing. A text seed's code and pixels
 * may change with a vendor bump that adds parts (update them here and say so in the release
 * notes); a seed code's avatar must never change.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { backgroundColor, decodeSeed, normalizeSeed, pixatar, seedFromText } from '../src/index.js';

const md5 = (data: Uint8Array) => createHash('md5').update(data).digest('hex');

const TEXT_SEEDS = [
  {
    text: 'octocat',
    code: 'px.ASMByrHtCcOaAj1fXEBDyipVOErZBwFd2AE_HAZdVTbyDX2JAR3X5AldBTX_Cn2IAR3U-gBCXzgIdbQBurY',
    transparent: 'px.ESMByrHtCcOaAj1fXEBDyipVOErZBwFd2AE_HAZdVTbyDX2JAR3X5AldBTX_Cn2IAR3U-gBCXzgIdbQBurY',
    background: '#a896e8',
    avatar: 'f4d6ab10742d1e16f3639db4bad848f1',
    clearAvatar: '1d16bbda5ce946cafd459e693106dc50',
    sheet: '07eb3d16b94164b21e1d182cc0997802',
  },
  {
    text: 'nntin',
    code: 'px.ASMByrGtA8OaAj2dhcssAL62PQUBXckCMA4GfRs1CfsKfdABSwMLC30NPP_-CH3FAkX8AQ',
    transparent: 'px.ESMByrGtA8OaAj2dhcssAL62PQUBXckCMA4GfRs1CfsKfdABSwMLC30NPP_-CH3FAkX8AQ',
    background: '#edabae',
    avatar: '527b95c93c63a2f83da01d2b5c70c1f3',
    clearAvatar: 'ec39dd9a80ba2b0a7fa7a482cd18cc2d',
    sheet: '4940eca697a09fb2748b39deb6df9e24',
  },
  {
    text: '',
    code: 'px.ASMBPUe_AXT3Aj0CPaDUsTrIpQC-BAZ9Dz_yJQp9IWH87wBCSHUIfQM1CQc',
    transparent: 'px.ESMBPUe_AXT3Aj0CPaDUsTrIpQC-BAZ9Dz_yJQp9IWH87wBCSHUIfQM1CQc',
    background: '#c1eaa4',
    avatar: 'cf6e29641e29ff9df55dcbe9acf4b47b',
    clearAvatar: '19c3d3996e9a772f945f625ebb3f8c04',
    sheet: 'b2309c60c1333a98a9e374e81e4d41de',
  },
  {
    text: '🎃',
    code: 'px.ASMBNkGtA8OaAj1r1cilUi-2PQQGfRwm0QgKfYIBRfkBC32sAUUBAQh9ImP97g',
    transparent: 'px.ESMBNkGtA8OaAj1r1cilUi-2PQQGfRwm0QgKfYIBRfkBC32sAUUBAQh9ImP97g',
    background: '#e2b9e4',
    avatar: 'df26536f512a27977add1d4eec22e1dd',
    clearAvatar: '73e7b47be3098c8eeae141e49253e6d1',
    sheet: '31aaabbad7eed4ce9e48d92f2773352c',
  },
  {
    // text, not a code: only seedFromText reads it as text
    text: 'px.hello',
    code: 'px.ASMBP2e9A8OaAj2Ab7E6QEN2UnhSBAZd8AE28gp9ERAiIgtCN0QIfeMBHOTr',
    transparent: 'px.ESMBP2e9A8OaAj2Ab7E6QEN2UnhSBAZd8AE28gp9ERAiIgtCN0QIfeMBHOTr',
    background: '#a9cfe0',
    avatar: 'e3c1319f93ba90a8d99d79ff433444a3',
    clearAvatar: '70258f441efece7a9775f112b816b86e',
    sheet: 'e0d52a35f6d567ab6b034c63adfad4ae',
  },
  {
    // the web app's #t. is only its address form: to the package, t.octocat is plain text
    text: 't.octocat',
    code: 'px.ASMBP2fPBnT3Aj0CPWExdrN4Uh7wBgFdzgFEMwxdkwJFAgZ9FTTHwwl94gEc3uILbR9j1QBCAGU',
    transparent: 'px.ESMBP2fPBnT3Aj0CPWExdrN4Uh7wBgFdzgFEMwxdkwJFAgZ9FTTHwwl94gEc3uILbR9j1QBCAGU',
    background: '#e5b8d4',
    avatar: '2b2f85290745b77180094c673aaf120b',
    clearAvatar: '802e371416dbd7003336cbaa80b0d539',
    sheet: '1a9378a7eb0f9dadf203653961f82032',
  },
];

/** Codes from test/fixtures/legacy-seeds.json (made before the background flag), and their avatars. */
const CODE_AVATARS = {
  'px.ASMByrHvA3T3Aj0CPfFcyKV2swC-tj0FBn0dKu0BCV2CAUX3Cn2sAUX5AQt9VUUBAQh9iAEd1_g': '10f4d2f8b9fc1681fa2e1e0a68108a40',
  'px.ASMByrGtA8OaAj1fXD74dlK2PQQGXdQBNvIKeTYHCAtCLQYIfQM1CQc': '844b71bad4777ba79f97b451ba6ee258',
  'px.ASMBNkHvC3T3Aj0CPYUSQEPQe1IveFKfYAcGfQ8_8iUNddsCXV4JXZMCRfcKfQcCursLfdgCDCT6AEJfOAh9kwJF_AE':
    'ff6d6d01b8ed14468e4872783c43cc9b',
};

describe('pinned text seeds', () => {
  for (const seed of TEXT_SEEDS) {
    it(`${JSON.stringify(seed.text)} makes its code, colour and pixels`, () => {
      expect(seedFromText(seed.text)).toBe(seed.code);
      expect(seedFromText(seed.text, { background: 'transparent' })).toBe(seed.transparent);
      expect(backgroundColor(seed.code)).toBe(seed.background);

      const character = pixatar(seed.code);
      expect(character.background).toBe(seed.background);
      expect(md5(character.avatarPng({ scale: 2 }))).toBe(seed.avatar);
      expect(md5(character.sheetPng())).toBe(seed.sheet);
      expect(md5(pixatar(seed.transparent).avatarPng({ scale: 2 }))).toBe(seed.clearAvatar);
      // the transparent flag leaves the colour and the sheet alone
      expect(pixatar(seed.transparent).background).toBe(seed.background);
      expect(md5(pixatar(seed.transparent).sheetPng())).toBe(seed.sheet);

      // the text itself, given to pixatar(), draws the same as its code (px. text aside: that's a code)
      if (seed.text.startsWith('px.')) return;
      expect(normalizeSeed(seed.text)).toBe(seed.code);
      expect(decodeSeed(seed.text).background).toBe('color');
      expect(pixatar(seed.text).seed).toBe(seed.code);
      expect(md5(pixatar(seed.text).avatarPng({ scale: 2 }))).toBe(seed.avatar);
      expect(pixatar(seed.text, { background: 'transparent' }).seed).toBe(seed.transparent);
    });
  }
});

describe('pinned seed codes', () => {
  it('draw the avatars they always did', () => {
    for (const [code, avatar] of Object.entries(CODE_AVATARS)) {
      expect(md5(pixatar(code).avatarPng({ scale: 2 })), code).toBe(avatar);
      expect(normalizeSeed(code)).toBe(code);
    }
  });
});
