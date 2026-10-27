/**
 * The two globals this service exchanges with the page it screenshots.
 *
 * Both are upstream's, declared in `vendor/pixel-agents/webview-ui/src/testHooks.ts`
 * — not importable from here, since that would pull the whole upstream test
 * harness into a Node service. So they are re-declared, once, instead of being
 * cast at each `page.evaluate()`/`waitForFunction()` boundary.
 *
 * Three ad-hoc casts used to do this job and disagreed with each other: one
 * widened `window` to `Record<string, unknown>`, which erases the property name
 * entirely — a typo'd `__PIXEL_AGENT_E2E` would have type-checked, the hooks
 * would never have switched on, and render.ts would have sat out its
 * `waitForFunction` timeout with nothing to point at. The other two declared
 * `getFurnitureCount` with two different types.
 *
 * `lib: ["DOM"]` is already on for exactly these callbacks (see tsconfig.json),
 * and this file is picked up by its `src/**\/*` include.
 */
declare global {
  interface Window {
    /** Set before navigation; upstream only installs its test hooks when it is true. */
    __PIXEL_AGENTS_E2E?: boolean;
    __pixelAgentsTestHooks?: {
      /** Appears once the app has mounted, which is what render.ts waits on. */
      getFurnitureCount?: () => number;
    };
  }
}

export {};
