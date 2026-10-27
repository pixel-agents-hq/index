/// <reference types="vite/client" />

/**
 * The typed view of the `VITE_*` variables this app reads. Without it
 * `import.meta.env.VITE_API_BASE_URL` is `any`, which is how a typo in the
 * variable name becomes a silent same-origin request rather than a build error.
 */
interface ImportMetaEnv {
  /**
   * Absolute origin of the API. Optional, and deliberately allowed to be the
   * empty string — see client.ts for why that case matters.
   */
  readonly VITE_API_BASE_URL?: string;
}

/**
 * True only on a Vercel *preview* deployment — see `vite.config.ts`, which
 * inlines it from the `VERCEL_ENV` system variable at build time.
 *
 * Gates the candidate Pixel Agents renders (#26) so production, GitHub Pages
 * and local dev can never show them, whatever files happen to be present.
 */
declare const __VENDOR_PREVIEW__: boolean;
/** Pinned Pixel Agents commit, used to address immutable live-office assets. */
declare const __PIXEL_AGENTS_COMMIT__: string;
/** The pin's release version (its package.json), or null if unreadable at build time. */
declare const __PIXEL_AGENTS_VERSION__: string | null;
/** Upstream repository URL from `.gitmodules`, without `.git`; null if unreadable. */
declare const __PIXEL_AGENTS_REPO__: string | null;

// Upstream declares this in testHooks.ts, which the full Pixel Agents App
// imports. The focused live-office wrapper intentionally does not import that
// test harness, but two shared modules still reference the optional log.
interface Window {
  __pixelAgentsTestHooks?: {
    playedSounds?: { kind: string; at: number }[];
    messageLog?: {
      at: number;
      type: string;
      id?: number;
      toolName?: string;
      status?: string;
      toolId?: string;
      parentToolId?: string;
    }[];
  };
}
