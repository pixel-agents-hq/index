import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  bundledLayoutRevision,
  furnitureCatalog,
  knownFurnitureIds,
  mergeFurnitureCatalog,
  upstreamCommitFile,
  upstreamPin,
} from './upstream.js';

/**
 * These run against the real pinned submodule rather than a fixture, on purpose:
 * the value of this package is that it agrees with the upstream we actually
 * ship, and a mocked catalog would prove nothing about that.
 */
describe('furnitureCatalog', () => {
  const catalog = furnitureCatalog();

  it('reads the pinned upstream', () => {
    expect(catalog.size).toBeGreaterThan(0);
  });

  it('inherits placement props from manifest group roots', () => {
    // canPlaceOnWalls and the footprint sit on the group root, not on the leaf
    // asset. A walker that only reads leaves loses them and then rejects valid
    // wall placements.
    const clock = catalog.get('CLOCK');
    expect(clock).toBeDefined();
    expect(clock?.canPlaceOnWalls).toBe(true);
    expect(clock?.footprintH).toBe(2);
  });

  it('synthesises the virtual :left ids that layouts store verbatim', () => {
    // Upstream's furnitureCatalog.ts creates a `<id>:left` entry for mirrorSide
    // assets with orientation "side". Layouts reference that id directly, so a
    // catalog without it reports valid furniture as unknown.
    const left = [...catalog.keys()].filter((id) => id.endsWith(':left'));
    expect(left.length).toBeGreaterThan(0);
    expect(left).toContain('PC_SIDE:left');

    const base = catalog.get('PC_SIDE');
    const mirrored = catalog.get('PC_SIDE:left');
    expect(base?.mirrorSide).toBe(true);
    expect(mirrored?.orientation).toBe('left');
    // The mirrored entry keeps the original's placement rules.
    expect(mirrored?.footprintW).toBe(base?.footprintW);
    expect(mirrored?.canPlaceOnWalls).toBe(base?.canPlaceOnWalls);
  });

  it('knownFurnitureIds agrees with the catalog', () => {
    expect(knownFurnitureIds()).toEqual(new Set(catalog.keys()));
  });
});

describe('mergeFurnitureCatalog (#101)', () => {
  const base = furnitureCatalog();

  it('adds a new entry without mutating the base catalog', () => {
    const merged = mergeFurnitureCatalog(base, [
      { id: 'MY_CUSTOM_CHAIR', category: 'chairs', footprintW: 1, footprintH: 1 },
    ]);
    expect(merged.get('MY_CUSTOM_CHAIR')).toEqual({ category: 'chairs', footprintW: 1, footprintH: 1 });
    expect(base.has('MY_CUSTOM_CHAIR')).toBe(false);
    // Every built-in entry is still there — this extends, it doesn't replace.
    expect(merged.size).toBe(base.size + 1);
  });

  it('lets a custom entry override a built-in id, last write wins', () => {
    const [someId] = base.keys();
    expect(someId).toBeDefined();
    const merged = mergeFurnitureCatalog(base, [{ id: someId as string, category: 'overridden' }]);
    expect(merged.get(someId as string)).toEqual({ category: 'overridden' });
    expect(base.get(someId as string)?.category).not.toBe('overridden');
  });

  it('is a no-op for an empty extra list', () => {
    const merged = mergeFurnitureCatalog(base, []);
    expect(merged).toEqual(base);
    expect(merged).not.toBe(base); // still a copy, not the same Map instance
  });
});

describe('bundledLayoutRevision', () => {
  it('reads a non-negative integer from the pinned default layout', () => {
    const revision = bundledLayoutRevision();
    expect(Number.isInteger(revision)).toBe(true);
    expect(revision).toBeGreaterThanOrEqual(0);
  });
});

describe('upstreamPin', () => {
  const pin = upstreamPin();

  it('reports the pinned version and a full commit sha', () => {
    expect(pin.version).toMatch(/^\d+\.\d+\.\d+/);
    // null is legitimate for a tarball checkout; a short or dirty sha is not.
    if (pin.commit !== null) expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('carries the revision every published layout is measured against', () => {
    expect(pin.layoutRevision).toBe(bundledLayoutRevision());
  });
});

/**
 * The path every deployed image takes.
 *
 * A container's `vendor/pixel-agents/.git` is a pointer to a gitdir that was
 * never copied into it, so git cannot answer there however much of the tree is
 * copied. The pin travels as a sibling file instead. These build a checkout
 * with no git at all, which is exactly the shape a container has.
 */
describe('upstreamPin without a readable git', () => {
  const temporary: string[] = [];
  afterEach(() => {
    for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function detachedCheckout(commit: string | null): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-stamp-'));
    temporary.push(root);
    const dir = path.join(root, 'pixel-agents');
    fs.mkdirSync(path.join(dir, 'webview-ui/public/assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '4.5.6' }));
    fs.writeFileSync(
      path.join(dir, 'webview-ui/public/assets/default-layout-7.json'),
      JSON.stringify({ layoutRevision: 7 }),
    );
    if (commit !== null) fs.writeFileSync(`${dir}.commit`, `${commit}\n`);
    return dir;
  }

  it('reads the commit from the stamp beside the checkout', () => {
    const dir = detachedCheckout('b'.repeat(40));
    expect(upstreamPin(dir).commit).toBe('b'.repeat(40));
  });

  it('resolves the stamp as a sibling, never a file inside the checkout', () => {
    // Inside, it would show as dirty in the submodule and untracked in the
    // parent — permanent noise in every `git status`.
    const dir = detachedCheckout('b'.repeat(40));
    expect(upstreamCommitFile(dir)).toBe(`${dir}.commit`);
    expect(fs.existsSync(path.join(dir, '.commit'))).toBe(false);
  });

  it('reports null rather than a guess when there is no stamp', () => {
    expect(upstreamPin(detachedCheckout(null)).commit).toBeNull();
  });

  it('ignores a malformed stamp instead of reporting rubbish as a commit', () => {
    const dir = detachedCheckout(null);
    fs.writeFileSync(`${dir}.commit`, 'not-a-sha\n');
    expect(upstreamPin(dir).commit).toBeNull();
  });

  it('still carries the version and revision from the checkout itself', () => {
    const pin = upstreamPin(detachedCheckout('b'.repeat(40)));
    expect(pin.version).toBe('4.5.6');
    expect(pin.layoutRevision).toBe(7);
  });
});

describe('the shipped stamp', () => {
  it('equals the submodule pin, so an image reports the upstream the repo pins', () => {
    // The same assertion `npm run vendor:commit:check` makes in CI. Here too
    // because a stale stamp is invisible until something deployed reports the
    // wrong upstream, and by then it has been wrong for a while.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const gitlink = execFileSync('git', ['ls-tree', 'HEAD', 'vendor/pixel-agents'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    const pinned = /^160000 commit ([0-9a-f]{40})\t/.exec(gitlink.trim())?.[1];

    expect(pinned).toBeDefined();
    expect(fs.readFileSync(path.join(repoRoot, 'vendor/pixel-agents.commit'), 'utf-8').trim()).toBe(
      pinned,
    );
  });
});

describe('missing upstream', () => {
  it('fails with an actionable message rather than a bare ENOENT', () => {
    expect(() => furnitureCatalog('/nonexistent/pixel-agents')).toThrow(
      /git submodule update --init/,
    );
  });
});
