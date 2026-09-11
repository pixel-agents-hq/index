#!/usr/bin/env node
/**
 * Keep `custom-asset-furniture-manifest.schema.json`'s `category` enum equal
 * to the categories the pinned vendor's bundled furniture manifests actually
 * use.
 *
 *   node tools/generate-furniture-categories-schema.mjs           # write it
 *   node tools/generate-furniture-categories-schema.mjs --check    # verify it, exit 1 if stale
 *
 * ## Why a committed file at all
 *
 * This schema is published externally (`docs/custom-asset-zip-contract.md`
 * tells producers like pixel-art-mcp to pin to a commit SHA of this repo,
 * never a branch) — it has to stay a stable, git-versioned artifact a
 * third party can fetch at a fixed commit, not something computed fresh on
 * every request. So the category enum is generated from
 * `furnitureCategories()` (`@pixel-index/layout-core`, which itself derives
 * from the pinned vendor's real bundled manifests, not a hand-typed list)
 * and then committed, the same way `vendor/pixel-agents.commit` is — see
 * `tools/vendor-commit.mjs`, which this script's `--check`/write shape
 * mirrors directly.
 *
 * Requires `@pixel-index/layout-core` to already be built (`npm run
 * build:core`) — unlike `vendor-commit.mjs`, which is dependency-free, this
 * one needs the real function, not a re-implementation of it. Both npm
 * scripts that run this file chain `build:core` first.
 *
 * ## Targeted edit, not a regeneration
 *
 * The rest of this schema is hand-written (descriptions, `$defs`, `allOf`
 * conditionals) — round-tripping the whole document through
 * `JSON.parse`/`JSON.stringify` would reformat every line and bury the real
 * change in an unreviewable diff. Instead this does a regex-anchored
 * text replacement of only the `category` property's own `enum` and
 * `description` fields, leaving every other byte of the file untouched.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { furnitureCategories } from '@pixel-index/layout-core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  'packages/layout-core/schema/custom-asset-furniture-manifest.schema.json',
);

// Anchored on the "category" key itself (not just "enum"+"description"
// adjacency, which "groupType" also has) so only this one property's block
// is ever touched.
const CATEGORY_BLOCK_RE =
  /("category":\s*\{\s*"type":\s*"string",\s*"enum":\s*)\[[^\]]*\](\s*,\s*"description":\s*)"(?:[^"\\]|\\.)*"(\s*\})/;

function describeCategories(categories) {
  return (
    "Generated from the categories the pinned vendor's bundled furniture manifests " +
    `actually use (currently: ${categories.join(', ')}) — not a fixed list. Run ` +
    '`npm run furniture-categories:schema` to regenerate after a vendor bump.'
  );
}

function render(raw, categories) {
  const match = CATEGORY_BLOCK_RE.exec(raw);
  if (!match) {
    throw new Error(
      `Could not find the "category" property's enum/description block in ${SCHEMA_PATH} — ` +
        'the schema may have been reshaped; update CATEGORY_BLOCK_RE to match.',
    );
  }
  const [, pre, mid, post] = match;
  const enumJson = `[${categories.map((category) => JSON.stringify(category)).join(', ')}]`;
  const descriptionJson = JSON.stringify(describeCategories(categories));
  return raw.slice(0, match.index) + pre + enumJson + mid + descriptionJson + post + raw.slice(match.index + match[0].length);
}

const check = process.argv.includes('--check');
const categories = furnitureCategories();
const raw = fs.readFileSync(SCHEMA_PATH, 'utf-8');
const rendered = render(raw, categories);
const matches = rendered === raw;

if (check) {
  if (matches) {
    console.log(`custom-asset-furniture-manifest.schema.json's category enum matches (${categories.join(', ')}).`);
    process.exit(0);
  }
  const current = /"enum":\s*(\[[^\]]*\])/.exec(CATEGORY_BLOCK_RE.exec(raw)?.[0] ?? '')?.[1] ?? '(unreadable)';
  console.error(
    `custom-asset-furniture-manifest.schema.json's category enum is ${current}, ` +
      `but the pinned vendor's bundled manifests currently use ${JSON.stringify(categories)}.\n` +
      'Run: npm run furniture-categories:schema',
  );
  process.exit(1);
}

fs.writeFileSync(SCHEMA_PATH, rendered);
console.log(
  matches
    ? `custom-asset-furniture-manifest.schema.json's category enum already matches (${categories.join(', ')}).`
    : `custom-asset-furniture-manifest.schema.json's category enum -> ${categories.join(', ')}.`,
);
