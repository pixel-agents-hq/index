/**
 * Writes `services/api/src/assets/builtinProfiles.json`: the pinned
 * upstream's default character profiles, each with its composed 128x96
 * sheet as a PNG, for `builtinSync.ts` to publish as the built-in
 * characters.
 *
 *   npm run builtin-profiles          # write it
 *   npm run builtin-profiles:check    # verify it, exit 1 if it drifted
 *
 * ## Why a committed file
 *
 * Upstream no longer ships character PNGs: its cast is profiles composed
 * from wardrobe parts by webview code (`characters/renderer.ts`). The API
 * image carries only the vendor's `webview-ui/public/assets` and never runs
 * upstream TypeScript, so the composition happens here, with upstream's own
 * renderer (`defaultCast.ts`), and the result travels as data. It lives
 * here, beside the build scripts, because this is where the repository lets
 * code import the vendored upstream (eslint.config.js's boundaries). `--check` runs in CI beside `vendor:commit:check`, so a vendor bump
 * that changes the default cast or its art can't land without regenerating
 * this file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';

import { defaultCastSheets } from './defaultCast.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(REPO_ROOT, 'services/api/src/assets/builtinProfiles.json');

function sheetPng(sheet: Uint8ClampedArray): string {
  const png = new PNG({ width: 128, height: 96 });
  png.data = Buffer.from(sheet);
  return PNG.sync.write(png).toString('base64');
}

const profiles = defaultCastSheets(path.join(REPO_ROOT, 'vendor/pixel-agents')).map(({ profile, sheet }) => ({
  profile,
  sheetPng: sheetPng(sheet),
}));
const text = `${JSON.stringify({ profiles }, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== text) {
    console.error(
      `${path.relative(REPO_ROOT, OUT)} does not match the pinned upstream's default cast.\n` +
        'Run: npm run builtin-profiles',
    );
    process.exit(1);
  }
  console.log(`${path.relative(REPO_ROOT, OUT)} matches the pinned upstream's ${profiles.length} default profiles.`);
} else {
  fs.writeFileSync(OUT, text);
  console.log(`Wrote ${profiles.length} default profiles to ${path.relative(REPO_ROOT, OUT)}.`);
}
