# @pixel-index/pixatar

Deterministic [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) characters. A seed makes a character, the same seed always makes the same character, and pixatar draws it as:

- **a sprite sheet**: Pixel Agents' 128×96 character sheet (rows down, up, right; 8 frames each: walk ×3, type ×2, read ×2, seated)
- **an avatar**: Pixel Agents' own mug shot (the 20×20 head square of the front-facing sprite, centred on it) on a **background colour derived from the seed**, or on a transparent background if the seed code says so

The sprite sheet is always transparent.

The wardrobe, the profile format, the randomizer and the renderer are Pixel Agents' own, bundled from a pinned checkout. When Pixel Agents adds parts (a seasonal theme, say), pixatar picks them up through a vendor bump and a version change.

Works in Node 22+ and in browsers. No canvas, no native code, one small dependency ([fflate](https://github.com/101arrowz/fflate)).

In this repository it draws the seeds in the web app's character designer (`/assets/design`, see [docs/custom-assets.md](../../docs/custom-assets.md#seeds-a-character-from-any-text-like-an-identicon)). Its `pixatar` command, with the [Python client](python/README.md), is how a project outside this repo makes the same avatars. The package is private for now, but kept ready to publish: see [PUBLISHING.md](PUBLISHING.md).

It began as a port of the standalone pixatar project (nntin-bot/pixatar at `06c29aa`). It is pixel-index's own code now and depends on nothing from that repository.

```js
import { pixatar } from '@pixel-index/pixatar';

const character = pixatar('octocat');
character.seed;         // 'px.ASMByrHtCcOa…': this exact character, forever
character.background;   // '#a896e8'
character.avatarBackground;         // 'color' (or 'transparent', as the seed code says)
character.avatarPng({ scale: 8 });  // Uint8Array, a 160×160 PNG
character.sheetPng();               // Uint8Array, the 128×96 sprite sheet
character.profile;                  // the Pixel Agents character profile
```

## Seeds

There are two kinds of seed: **seed codes** (`px.` followed by base64url) and **free text**.

- **A seed code is the character profile itself**, written compactly, plus how its avatar is exported. Decoding it gives back exactly that profile, and any change to the character changes its code. A seed code never depends on chance, so it keeps its character across pixatar versions for as long as Pixel Agents keeps the parts it names. Codes are validated: a damaged or unknown one throws a `PixatarError` (`This seed code has unknown eye flags.`, and so on).
- **Free text is any string at all.** Its length plays no role. Its SHA-256 drives Pixel Agents' own randomizer (the Characters view's 🎲) in counter mode, so every random draw depends on every character of the text. Changing one character deals a new character from scratch, not one trait. Free text **generates a seed code** (`seedFromText`), and is drawn through that code. The same text gives the same code for a given wardrobe. A vendor bump that adds parts may deal text differently; the codes it made before stay put.

`profileFromSeed`, `normalizeSeed` and `pixatar` read a string starting with `px.` as a code and anything else as text. Use `profileFromText` / `seedFromText` for text that happens to start with `px.`.

```js
pixatar('px.ASMByrHtCcOa…');     // from a seed code
pixatar('octocat');              // from free text
seedFromText('octocat');         // 'px.ASMByrHtCcOa…': the code a text seed makes
pixatar(seedFromText('px.hi'));  // text that starts with px.
```

There is no prefix for text in the package: free text is passed as it is. The designer's `?seed=` and `?text=` are only how its address holds the two kinds.

`test/pinned.test.ts` pins a few text seeds and seed codes to their codes, background colours and avatar and sheet PNGs.

### The avatar background flag

A seed code also says whether the avatar PNG has its background colour (`'color'`, the default) or a transparent background (`'transparent'`):

```js
const clear = seedFromProfile(profile, { background: 'transparent' });
decodeSeedCode(clear);              // { profile, background: 'transparent' }
pixatar(clear).avatarPng();         // transparent around the head
pixatar(clear).sheetPng();          // the same transparent sheet as ever
seedFromText('octocat', { background: 'transparent' });
```

It is one bit (`0x10`) in the code's first (format) byte. Codes made before it existed don't have it, so they decode to `'color'` and draw exactly as before, and a coloured code is byte for byte the code pixatar always made. The background colour is hashed from the coloured code, so it doesn't change when the flag does.

## Command line

The package installs a `pixatar` command (Node 22+):

```sh
pixatar avatar octocat --scale 8 --out octocat.png    # or > octocat.png
pixatar avatar px.ASMByrHtCcOa… --background transparent --out clear.png
pixatar sheet octocat --scale 2 --out sheet.png
pixatar info octocat                                  # seed code, colours and profile, as JSON
pixatar avatar --text px.hello --out hello.png        # text that starts with px.
pixatar avatar --out dash.png -- -dash                # a seed that starts with a dash
pixatar --version
```

`pixatar serve` keeps one process running for many avatars. It reads one JSON request per line on stdin and writes one JSON response per line on stdout, with the PNG in base64. This is how the [Python client](python) uses pixatar. The protocol is documented in [its README](python/README.md#the-protocol).

## API

| | |
| --- | --- |
| `pixatar(seedOrProfile, { background? })` | `{ seed, profile, background, avatarBackground, sheet(), frame(), avatar(), sheetPng(), avatarPng(), sprites() }`; `background` overrides the seed's flag |
| `profileFromSeed(seed)` | the character profile a seed stands for |
| `decodeSeed(seed)` / `decodeSeedCode(code)` | `{ profile, background }`: everything a seed says |
| `seedFromProfile(profile, { background? })` | its seed code (customise a profile, get its new seed) |
| `profileFromText(text)` / `seedFromText(text, { background? })` | the character and seed code a free-text seed makes (any string) |
| `normalizeSeed(seed)` / `isSeedCode(seed)` / `randomSeed({ background? })` | |
| `backgroundColor(seedOrProfile)` | the avatar's background, `#rrggbb` |
| `renderSheet(profile, { scale, background })` | the sprite sheet, as RGBA |
| `renderFrame(profile, { direction, frame, scale, background })` | one 16×32 frame; `direction` is `down`, `up`, `right` or `left` (mirrored) |
| `renderAvatar(profile, { scale, background })` | the avatar, as RGBA; `background: null` for a transparent one |
| `renderSprites(profile)` | the sheet as Pixel Agents' office takes a character (hex pixel grids) |
| `encodePng(image)` | any of the above as PNG bytes |
| `SHEET_FRAMES`, `WALK_FRAME_DURATION_SEC`, `TYPE_FRAME_DURATION_SEC` | Pixel Agents' animation timings, to animate frames as the office does |
| `VENDOR` | the Pixel Agents version and commit this build draws with |

Images are `{ width, height, data }` with straight 8-bit RGBA (the shape of an `ImageData`), so in a browser `ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0)` draws one.

A profile is Pixel Agents' character config: add a `name` and its Characters view loads it with **Load config**.

## Development

```sh
npm run build --workspace @pixel-index/pixatar   # dist/index.js, dist/index.d.ts, dist/cli.js
npm test --workspace @pixel-index/pixatar
```

Before every build, test and typecheck, `scripts/generate-wardrobe.mjs` bakes the pinned wardrobe (`vendor/pixel-agents/webview-ui/src/characters/art`) into `src/generated/`, which is not committed. It reads the pin from `vendor/pixel-agents.commit`, so it also works where there is no git, such as the web Docker build. `src/vendor.ts` is the one module that imports the vendored sources. It is compiled at the reduced strictness of `tsconfig.json`, like `apps/web/src/live-office`, and bundled into `dist`, so consumers never see vendor types.

A vendor bump re-runs all of this. `test/fixtures/legacy-seeds.json` pins what existing seed codes decode to, and must never change. The pinned text seeds and snapshots may change on purpose when the bump adds parts or redraws art: see the advance-vendor skill (`.claude/skills/advance-vendor/SKILL.md`).

## Credits

Characters, wardrobe and renderer: [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) (MIT). Its character art is based on [JIK-A-4's Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack) pack.
