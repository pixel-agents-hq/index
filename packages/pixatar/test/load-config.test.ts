/**
 * A seed's character leaves pixatar as a Pixel Agents character config: the index's designer
 * publishes it (the renderer composes it with upstream's parseConfigFile), and the Characters
 * view's Load config reads it. Both must read back the very character the seed made.
 */

import { describe, expect, it } from 'vitest';

import { profileFromSeed, profileFromText, randomSeed, seedFromProfile } from '../src/index.js';
import { parseConfigFile } from '../src/vendor.js';
import { getWardrobe } from '../src/wardrobe.js';

describe('a seed’s profile as a config file', () => {
  const profiles = [
    ...['octocat', 'nntin', '', '🎃', 'someone@example.com'].map((text) => profileFromText(text)),
    ...Array.from({ length: 20 }, () => randomSeed()).map((code) => profileFromSeed(code)),
  ];

  it('is read by upstream’s Load config as the same character, under its name', () => {
    for (const profile of profiles) {
      const read = parseConfigFile(getWardrobe(), JSON.stringify({ ...profile, name: 'Octo' }), 'octo.json');
      expect(read).toHaveLength(1);
      expect(read?.[0]?.name).toBe('Octo');
      expect(seedFromProfile(read?.[0])).toBe(seedFromProfile(profile));
    }
  });

  it('is named after its file when it has no name', () => {
    const [profile] = profiles;
    expect(parseConfigFile(getWardrobe(), JSON.stringify(profile), 'Night Owl.json')?.[0]?.name).toBe('Night Owl');
  });
});
