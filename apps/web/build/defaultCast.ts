import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { sheetToDirectionSprites } from '../../../vendor/pixel-agents/core/src/assets/characterSheet.ts';
import type { CharacterDirectionSprites } from '../../../vendor/pixel-agents/core/src/assets/types.ts';
import { DEFAULT_CHARACTER_PROFILES } from '../../../vendor/pixel-agents/core/src/defaultCharacterProfiles.ts';
import { CharacterRenderer } from '../../../vendor/pixel-agents/webview-ui/src/characters/renderer.ts';
import { SHEET_W } from '../../../vendor/pixel-agents/webview-ui/src/characters/sheet.ts';
import { EYE_FOLDERS } from '../../../vendor/pixel-agents/webview-ui/src/characters/slots.ts';
import {
  decodeWardrobe,
  parseWardrobeManifest,
  type Rgba,
} from '../../../vendor/pixel-agents/webview-ui/src/characters/wardrobe.ts';

/** Every PNG under `dir`, keyed the way upstream's `loadWardrobe.ts` keys them ('hair/bob'). */
function readArt(dir: string): Map<string, Rgba> {
  const files = new Map<string, Rgba>();
  const walk = (sub: string) => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.png')) {
        const png = PNG.sync.read(fs.readFileSync(path.join(dir, rel)));
        files.set(rel.replace(/\.png$/, ''), {
          width: png.width,
          height: png.height,
          data: new Uint8ClampedArray(png.data),
        });
      }
    }
  };
  walk('');
  return files;
}

/**
 * Upstream's default cast as the office's character sprites. Upstream no
 * longer bundles `char_N.png`: its webview composes each character profile
 * from wardrobe parts at runtime (`characters/castStore.ts` →
 * `officeSprites.ts`). The live office has no cast store, so the same
 * renderer composes `DEFAULT_CHARACTER_PROFILES` here, at build time, from the
 * same `art/` PNGs `loadWardrobe.ts` inlines; palette N is profile N, as in
 * upstream's office.
 */
export function composeDefaultCast(upstreamRoot: string): CharacterDirectionSprites[] {
  const artDir = path.join(upstreamRoot, 'webview-ui/src/characters/art');
  const manifest = parseWardrobeManifest(
    JSON.parse(fs.readFileSync(path.join(artDir, 'wardrobe.json'), 'utf8')) as unknown,
  );
  const renderer = new CharacterRenderer(decodeWardrobe(manifest, readArt(artDir), EYE_FOLDERS));
  return DEFAULT_CHARACTER_PROFILES.map((profile) =>
    sheetToDirectionSprites(renderer.sheet(profile), SHEET_W),
  );
}
