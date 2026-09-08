/**
 * Where the gate's layouts come from: the committed seed, or the live index.
 *
 * Both sources produce the same `HarnessLayout[]`, so nothing downstream knows
 * or cares which one it is running against — the only difference between the
 * hermetic gate and the live gate is which of these two functions the CLI
 * called.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { HarnessInfraError, type HarnessLayout } from './types.js';

/** `<dir>/<slug>/layout.json`, the convention the seed and the validate CLI share. */
export function loadSeedLayouts(dir: string): HarnessLayout[] {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) {
    throw new HarnessInfraError(`No layout directory at ${root}.`);
  }

  const layouts: HarnessLayout[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'layout.json');
    if (!fs.existsSync(file)) continue;
    // #105: a seed layout may carry a sibling `custom-assets.json` — the same
    // `RenderCustomAsset[]` shape a real `/render` request embeds — to prove
    // the custom furniture/character/pet interception paths survive a vendor
    // bump, not just the bundled catalog.
    const customAssetsFile = path.join(root, entry.name, 'custom-assets.json');
    const customAssets = fs.existsSync(customAssetsFile)
      ? (JSON.parse(fs.readFileSync(customAssetsFile, 'utf-8')) as HarnessLayout['customAssets'])
      : undefined;
    layouts.push({
      slug: entry.name,
      layout: JSON.parse(fs.readFileSync(file, 'utf-8')),
      ...(customAssets ? { customAssets } : {}),
    });
  }

  if (layouts.length === 0) {
    throw new HarnessInfraError(`No layouts found under ${root}.`);
  }
  return layouts;
}

/**
 * Every public layout from a running index, via the bulk export (#26).
 *
 * Everything that can go wrong here is an *infrastructure* failure, never a
 * verdict about the vendor — a self-hosted API being down says nothing about
 * whether a Pixel Agents bump breaks layouts, and reporting it as a breaking
 * change would be a lie that costs someone an afternoon.
 */
export async function fetchExportedLayouts(
  apiBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HarnessLayout[]> {
  const url = `${apiBaseUrl.replace(/\/$/, '')}/api/v1/export/layouts.ndjson`;

  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/x-ndjson' } });
  } catch (error) {
    throw new HarnessInfraError(`Could not reach the index at ${url}.`, error);
  }
  if (response.status === 404) {
    // Worth its own message rather than folding into the generic non-2xx case:
    // a 404 *specifically here* almost never means "wrong URL", it means the
    // index is running a build from before this endpoint existed. Said plainly,
    // that is a one-line fix; said as "could not be read", it sends someone
    // looking for a misconfigured variable that is perfectly fine.
    throw new HarnessInfraError(
      `The index at ${apiBaseUrl} has no ${new URL(url).pathname} (404). ` +
        'That endpoint ships with the vendor-update gate, so the API is almost ' +
        'certainly running a build from before it existed — redeploy the API.',
    );
  }
  if (!response.ok) {
    throw new HarnessInfraError(`The index answered ${response.status} for ${url}.`);
  }

  const body = await response.text();
  const layouts: HarnessLayout[] = [];
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue;
    let row: { slug?: unknown; layout?: unknown };
    try {
      row = JSON.parse(line) as typeof row;
    } catch (error) {
      throw new HarnessInfraError(`The export contained a line that is not JSON.`, error);
    }
    if (typeof row.slug !== 'string' || row.layout === undefined) {
      throw new HarnessInfraError('The export contained a row without a slug and a layout.');
    }
    layouts.push({ slug: row.slug, layout: row.layout });
  }

  // The export cannot signal a mid-stream failure with a status code — the 200
  // is long gone by then — so it publishes the line count up front instead.
  // Without this check a truncated download would look like a smaller index and
  // the gate would cheerfully pass on the half of it that arrived.
  const declared = response.headers.get('x-total-count');
  if (declared !== null && Number(declared) !== layouts.length) {
    throw new HarnessInfraError(
      `The export declared ${declared} layouts but ${layouts.length} arrived — the stream was truncated.`,
    );
  }

  return layouts;
}
