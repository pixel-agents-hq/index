import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

import { liveOfficeAssets } from './build/liveOfficeAssets.ts';

/** This config is ESM, so `__dirname` does not exist. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PIXEL_AGENTS_COMMIT = fs
  .readFileSync(path.resolve(HERE, '../../vendor/pixel-agents.commit'), 'utf8')
  .trim();

/**
 * The pinned upstream's release version and repository, for the header's
 * "Pixel Agents vX.Y.Z" link (Layout.tsx). Both are best-effort: the link
 * degrades to plain text rather than failing a build that lacks either.
 *
 * The version is the submodule's own package.json (the Docker build copies
 * it). The repository comes from `.gitmodules`, the one place the submodule
 * URL is declared, so a fork pointing at its own upstream links there.
 */
function readPixelAgentsVersion(): string | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(HERE, '../../vendor/pixel-agents/package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function readPixelAgentsRepo(): string | null {
  try {
    const gitmodules = fs.readFileSync(path.resolve(HERE, '../../.gitmodules'), 'utf8');
    const section = gitmodules.split(/^\[submodule /m).find((s) => s.startsWith('"vendor/pixel-agents"'));
    const url = section?.match(/^\s*url\s*=\s*(https:\/\/\S+?)(?:\.git)?\s*$/m)?.[1];
    return url ?? null;
  } catch {
    return null;
  }
}

/**
 * GitHub Pages has no server-side rewrite rules, so a hard refresh (or a
 * shared link) on any deep route — `/layouts/some-office` — 404s before the
 * SPA's router ever runs. This writes a `404.html` that stashes the visitor's
 * intended URL and bounces them to the real app root; `index.html`'s own
 * inline script (see index.html) restores it via `history.replaceState`
 * before React Router mounts, so the visitor lands on the page they actually
 * asked for. Two-file version of https://github.com/rafgraph/spa-github-pages
 * — there is no nested path-segment stripping to get right here because the
 * whole intended URL round-trips through sessionStorage, not just a suffix.
 *
 * A no-op on Vercel and local dev: they DO have rewrite rules (or don't need
 * any), so this 404.html is simply never requested there.
 */
function ghPagesSpaFallback(): Plugin {
  let base = '/';
  let outDir = 'dist';
  return {
    name: 'gh-pages-spa-fallback',
    configResolved(config) {
      base = config.base;
      outDir = config.build.outDir;
    },
    closeBundle() {
      const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Pixel Index</title>
    <script>
      sessionStorage.redirect = location.href;
    </script>
    <meta http-equiv="refresh" content="0;url=${base}" />
  </head>
  <body></body>
</html>
`;
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, '404.html'), html);
    },
  };
}

/**
 * Whether this build is allowed to show candidate Pixel Agents renders (#26).
 *
 * `VERCEL_ENV` is a Vercel system variable, set at build time to `production`,
 * `preview` or `development`. Requiring `preview` is *positive* identification:
 * production, GitHub Pages (where the variable does not exist at all) and local
 * dev are all excluded by default rather than by remembering to exclude them.
 *
 * This matters because the mechanism used to be scoped by a manifest committed
 * to the PR branch — which merged to `main` along with the pin, and so shipped
 * to production for the window before the API was redeployed. Deciding from the
 * *deployment* rather than from a file in the repository is what makes that
 * structurally impossible.
 */
const isVendorPreviewBuild = process.env.VERCEL_ENV === 'preview';

/**
 * Pull the candidate renders into `dist/` — only on a preview deployment, and
 * only when this build's pin actually has a published set.
 *
 * The manifest is no longer committed to the branch. It lives beside the PNGs
 * on the `vendor-previews` branch, and is fetched here, at build time. Three
 * things follow, all of them the point:
 *
 * - **Nothing enters git.** No manifest in the PR diff, and none on `main` after
 *   a merge, so production cannot inherit one.
 * - **A production build physically cannot have the file.** The runtime already
 *   treats a missing manifest as "no override", so the guard is the absence of
 *   the file rather than a flag someone could get wrong.
 * - **Visitors never hotlink `raw.githubusercontent.com`.** The images are
 *   downloaded once per build and served same-origin, off the same CDN as the
 *   rest of the site.
 *
 * Keyed on the pinned commit, so a preview of an unrelated branch asks for a
 * render set that was never published and gets a 404. Every failure here is
 * silent and means "no override" — the safe direction.
 */
function vendorPreviewAssets(): Plugin {
  return {
    name: 'vendor-preview-assets',
    apply: 'build',
    async closeBundle() {
      if (!isVendorPreviewBuild) return;

      const owner = process.env.VERCEL_GIT_REPO_OWNER;
      const repo = process.env.VERCEL_GIT_REPO_SLUG;
      if (!owner || !repo) return;

      const pinFile = path.resolve(HERE, '../../vendor/pixel-agents.commit');
      if (!fs.existsSync(pinFile)) return;
      const pin = fs.readFileSync(pinFile, 'utf-8').trim();
      if (!/^[0-9a-f]{40}$/.test(pin)) return;

      const base = `https://raw.githubusercontent.com/${owner}/${repo}/vendor-previews/${pin}`;
      const outDir = path.resolve(HERE, 'dist/vendor-preview');

      try {
        const response = await fetch(`${base}/manifest.json`);
        if (!response.ok) return;
        const manifest = (await response.json()) as {
          layouts?: Record<string, { file?: string }>;
        };

        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));

        let downloaded = 0;
        for (const entry of Object.values(manifest.layouts ?? {})) {
          if (!entry.file) continue;
          const png = await fetch(`${base}/${entry.file}`);
          if (!png.ok) continue;
          fs.writeFileSync(path.join(outDir, entry.file), Buffer.from(await png.arrayBuffer()));
          downloaded += 1;
        }
        console.log(`vendor-preview: ${pin.slice(0, 7)}, ${downloaded} candidate render(s).`);
      } catch {
        // Offline, rate-limited, nothing published for this pin. The site is
        // fine without it; it simply shows the API's images.
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [
      liveOfficeAssets(HERE),
      tailwindcss(),
      react(),
      ghPagesSpaFallback(),
      vendorPreviewAssets(),
    ],
    // Belt as well as braces. A production build cannot contain the manifest at
    // all (see above), so this is redundant today — but it is the guard that
    // would still hold if the file were ever committed into `public/` again,
    // which is precisely the mistake this replaces.
    define: {
      __VENDOR_PREVIEW__: JSON.stringify(isVendorPreviewBuild),
      __PIXEL_AGENTS_COMMIT__: JSON.stringify(PIXEL_AGENTS_COMMIT),
      __PIXEL_AGENTS_VERSION__: JSON.stringify(readPixelAgentsVersion()),
      __PIXEL_AGENTS_REPO__: JSON.stringify(readPixelAgentsRepo()),
    },
    // The vendor-update workflow installs the submodule's own dependencies
    // before exercising this build. Without dedupe, source imported across
    // that package boundary can resolve a second React and fail only in the
    // exact candidate-pin job this viewer is meant to protect.
    resolve: {
      dedupe: ['react', 'react-dom'],
    },
    // GitHub Pages project sites are served from a repo-name subpath
    // (https://<user>.github.io/<repo>/), which has to be baked into every
    // asset URL at build time — there is no way to detect it at runtime.
    // Vercel and local dev serve from the root, so this defaults to '/'.
    // Deliberately not hardcoded: a self-hoster forking this under a
    // different repo name needs a different value, set via VITE_BASE_PATH
    // at build time (see .github/workflows/pages.yml).
    base: env.VITE_BASE_PATH || '/',
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: {
          index: path.resolve(HERE, 'index.html'),
          liveOffice: path.resolve(HERE, 'live-office.html'),
          radio: path.resolve(HERE, 'radio.html'),
        },
      },
    },
  };
});
