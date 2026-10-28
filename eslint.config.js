import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * One flat config for the whole repository.
 *
 * It used to be one config for apps/web and nothing at all for
 * packages/layout-core, services/api, services/renderer and tools/ — which is
 * to say the two services holding every request handler, every SQL query and
 * every browser were the parts nobody linted. Four sibling configs would have
 * drifted the same way the four tsconfigs did (see tsconfig.strict.json), so
 * this is deliberately a single file with per-area overrides rather than a
 * shared preset each workspace re-exports.
 *
 * ESLint 10 resolves the config from the linted file upward, so `eslint .` from
 * a workspace directory finds this file and lints only that workspace — the
 * per-workspace `lint` scripts stay useful without a config of their own.
 *
 * The bar is `strictTypeChecked` + `stylisticTypeChecked` in full, minus the
 * exceptions below. It used to be `recommendedTypeChecked` plus a hand-picked
 * list of ten extra rules, which had two problems: a rule the presets add in a
 * future typescript-eslint release lands nowhere, and three rules were declined
 * for their report counts rather than for anything about the rules. Measured
 * before the switch, 35 of the rules the two presets add were already at zero
 * here — so the allow-list was mostly recording work already done.
 */

/**
 * A leading underscore means "deliberately unused" — the convention this
 * codebase already used (`_request` in a content-type parser it does not read,
 * `_canvasBox` in the rest-destructure that drops a key) before anything
 * enforced it. Spelling the patterns out is what makes the convention load-
 * bearing instead of decorative; without them the rule's answer to "how do I
 * say I meant it?" is an eslint-disable comment, which is worse.
 */
const unusedVarsWithUnderscoreEscape = {
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      destructuredArrayIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      ignoreRestSiblings: true,
    },
  ],
};

/**
 * Where this repository departs from the two presets.
 *
 * Every entry states what the rule is worth, not how many times it fires. A
 * count is a fact about today's code; it is not a reason, and the moment it is
 * written down it starts going stale (the previous version of this file claimed
 * `no-unnecessary-type-parameters` had "one finding" when it had three).
 */
const presetExceptions = {
  /**
   * OFF. It prescribes exactly the syntax `no-non-null-assertion` forbids —
   * every one of its reports reads "use a ! assertion to more succinctly remove
   * null and undefined" — and its autofix would undo that rule's work. The two
   * presets genuinely disagree here and this is the side we take: an assertion
   * is an assertion whether it is spelled `!` or `as NonNullable<T>`, and the
   * fix for both is a check that can fail.
   */
  '@typescript-eslint/non-nullable-type-assertion-style': 'off',

  /**
   * Not for strings. `??` and `||` genuinely differ there — the empty string is
   * falsy but not nullish — and this codebase depends on the difference: an
   * unset GitHub Actions repo variable interpolates to `''`, and
   * `import.meta.env.VITE_API_BASE_URL || fallback` is what stops that becoming
   * a same-origin request against the Pages domain (apps/web/src/api/client.ts).
   */
  '@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: { string: true } }],

  /**
   * Stricter than the preset's `error-handling-correctness-only`. The only
   * place a missing `await` changes behaviour is a returned promise inside a
   * try, where omitting it means the catch never sees the rejection — and
   * `in-try-catch` (the default) is the setting that says exactly that.
   */
  '@typescript-eslint/return-await': 'error',

  /**
   * The rule that catches `[object Object]` reaching a user. Numbers and
   * booleans in templates are fine and intended all over this codebase
   * (`${count} layouts`); objects, unions, `any`, `never`, regexps and nullish
   * values are not.
   *
   * The four explicit `false`s are the point. This entry used to read
   * `{ allowNumber: true, allowBoolean: true }` above a comment claiming
   * "objects, unions and `any` are not [allowed]" — which was false, because
   * the rule's own defaults are permissive and left `allowAny`, `allowNullish`,
   * `allowNever` and `allowRegExp` all on. `${maybeUndefined}` rendering the
   * literal text "undefined" into a redirect URL passed the lint for months.
   */
  '@typescript-eslint/restrict-template-expressions': [
    'error',
    {
      allowNumber: true,
      allowBoolean: true,
      allowAny: false,
      allowNullish: false,
      allowNever: false,
      allowRegExp: false,
    },
  ],

  /**
   * `onClick={() => setOpen(true)}` is idiomatic React, not a confusing void
   * expression, and it was ~58 of this rule's 60 reports. What survives is the
   * payload: a void value flowing somewhere it will actually be read.
   */
  '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],

  /**
   * `T[]`, the default. Measured both ways before choosing: `array` reports 4
   * sites and `array-simple` reports 11, so `T[]` is what this codebase already
   * converged on for simple and compound types alike.
   */
  '@typescript-eslint/array-type': ['error', { default: 'array' }],
};

/**
 * Correctness rules from core ESLint, beyond `js.configs.recommended`.
 *
 * All of these were measured at zero across every workspace *and* tools/, so
 * they cost nothing today and exist to catch the next occurrence. They live in
 * the shared block rather than the typed one because the untyped `.mjs` files
 * are exactly where a stray `==` is least likely to be noticed.
 *
 * Not here, and deliberately: `consistent-return` (17 reports — `noImplicitReturns`
 * in tsconfig.strict.json already governs the real case), `no-await-in-loop`
 * (16, every one a deliberately sequential loop), `require-atomic-updates` and
 * `no-promise-executor-return` (false-positive prone; the sites are
 * `new Promise((resolve) => setTimeout(resolve, 0))`), and taste rules such as
 * `no-else-return` that decide nothing.
 */
const coreCorrectnessRules = {
  eqeqeq: ['error', 'always'],
  'array-callback-return': 'error',
  'no-self-compare': 'error',
  'no-unmodified-loop-condition': 'error',
  'no-template-curly-in-string': 'error',
  'default-case-last': 'error',
  'no-param-reassign': 'error',
  'no-implicit-coercion': 'error',
};

/**
 * Architectural boundaries, as `no-restricted-imports` pattern groups.
 *
 * Every one of these was at zero when it was added, which is the point: they
 * are not a cleanup, they are the shape of the repository written down where
 * the next import that breaks it gets caught. Until now each was enforced by a
 * comment and a reviewer noticing.
 *
 * Composed rather than repeated because `no-restricted-imports` does not merge
 * across config objects — a later `files` block replaces the whole setting — so
 * an area that relaxes one boundary has to restate the others. `boundaries()`
 * below is what keeps that from turning into four divergent copies.
 */

/**
 * The vendored upstream is reachable from the live-office wrapper and its build
 * script, and from the avatar package's one vendor module, and nowhere else.
 *
 * Not tidiness: `apps/web/tsconfig.app.json` runs at full strictness and
 * *excludes* `src/live-office`, because vendor sources only compile under
 * `tsconfig.live-office.json` with `noUncheckedIndexedAccess` and
 * `exactOptionalPropertyTypes` turned back off. An import from anywhere else
 * pulls those sources into the strict project, which is precisely how #44's
 * `apps/web` flags were blocked in the first place.
 */
const noVendorOutsideLiveOffice = {
  group: ['**/vendor/pixel-agents/**'],
  message:
    'Only apps/web/src/live-office/**, apps/web/build/** and packages/pixatar/src/vendor.ts may ' +
    'import the vendored upstream — ' +
    'everything else compiles at a strictness those sources do not meet. Go through ' +
    '@pixel-index/layout-core, or through the live-office wrapper.',
};

/**
 * Workspaces talk to each other by package name, never by relative path.
 *
 * A `../../../packages/layout-core/src/...` import compiles and then ships a
 * second copy of the module, bypassing the `exports` map that decides what is
 * public. Only an import that escapes a workspace can contain these segments;
 * an intra-workspace `../db/client.js` does not.
 */
const noCrossWorkspaceReachAround = {
  group: ['**/packages/**', '**/services/**', '**/apps/**'],
  message:
    'Import another workspace by its package name (@pixel-index/…), not by relative path. ' +
    'Reaching around the package boundary bypasses its exports map and duplicates the module.',
};

/** The `exports` map publishes one entry point per package; deep imports route around it. */
const noDeepWorkspaceImport = {
  group: ['@pixel-index/*/dist/**', '@pixel-index/*/src/**'],
  message:
    'Import the package root (@pixel-index/layout-core). Its exports map deliberately publishes ' +
    'no deep subpath, so a deep import depends on a file layout that is free to change.',
};

/**
 * Test scaffolding does not belong in shipped code.
 *
 * This is why `one()` lives in `src/db/rows.ts` rather than beside the other
 * insert helpers in `src/test-support/` — twenty of its call sites are
 * production. `vitest` is named exactly, not `vitest/*`: `vitest/config` is a
 * build-config import and the four vitest config files legitimately use it.
 */
const TEST_SCAFFOLDING_MESSAGE =
  'Production code cannot import test scaffolding. Move the shared helper into src/ if both ' +
  'need it — see services/api/src/db/rows.ts.';

const noTestScaffoldingInProduction = {
  group: ['**/test-support/**', '**/*.test.*'],
  message: TEST_SCAFFOLDING_MESSAGE,
};

/**
 * An exact path, not a pattern: `vitest/config` is a build-config import that
 * the four vitest config files legitimately use, and a slash-less pattern would
 * catch it — along with `@testing-library/jest-dom/vitest`.
 */
const noVitestInProduction = { name: 'vitest', message: TEST_SCAFFOLDING_MESSAGE };

/** apps/web/src is a browser bundle. A Node builtin there is a build failure or a silent polyfill. */
const noNodeBuiltinsInTheSpa = {
  group: ['node:*'],
  message:
    'apps/web/src ships to a browser. Node builtins belong in build/, e2e/ or a config file.',
};

/**
 * Composes boundary entries into one `no-restricted-imports` setting.
 *
 * Entries with `name` become exact `paths`, entries with `group` become glob
 * `patterns`. The distinction matters: ESLint matches a slash-less pattern
 * gitignore-style, so `patterns: ['vitest']` also catches `vitest/config` and
 * `@testing-library/jest-dom/vitest`. `paths` compares the whole specifier.
 */
const boundaries = (...entries) => ({
  'no-restricted-imports': [
    'error',
    {
      paths: entries.filter((entry) => 'name' in entry),
      patterns: entries.filter((entry) => 'group' in entry),
    },
  ],
});

/** Everything that is allowed to import test scaffolding, because it is test scaffolding. */
const TEST_FILES = [
  '**/*.test.{ts,tsx}',
  '**/test-support/**/*.ts',
  '**/e2e/**/*.{ts,tsx}',
  'apps/web/src/test/**/*.{ts,tsx}',
];

/**
 * A hardcoded GitHub blob/repo URL bakes this instance's owner and branch
 * into shipped code — a self-hoster's fork breaks it immediately, and so did
 * this repo's own pending org transfer to pixel-agents-hq (three frontend
 * files had one hand-typed each, found and fixed one grep at a time). `GET /`
 * already exposes `repository` and, for a link pinned to an exact file,
 * `commit` — see services/api/src/root.ts for where those come from, and
 * apps/web/src/api/client.ts's `repoFileUrl()` for the frontend helper that
 * builds a link from them.
 *
 * Matches a bare string or a template literal's static text; it cannot see
 * across an interpolation (`` `https://github.com/${owner}/pixel-index` ``
 * would slip through), which is a known gap a no-restricted-syntax selector
 * cannot close, not an oversight.
 */
const GITHUB_REPOSITORY_PATTERN = /https?:\/\/github\.com\/[^/\s'"`]+\/[^/\s'"`]+/;

const GITHUB_REPOSITORY_MESSAGE =
  "Don't hardcode a GitHub repository URL. Build it from GET /'s `repository` (and `commit`, " +
  'for a link to a specific file) instead — see services/api/src/root.ts for where those come ' +
  "from, and apps/web/src/api/client.ts's repoFileUrl() for the frontend helper.";

const noHardcodedGithubRepository = {
  'no-restricted-syntax': [
    'error',
    {
      selector: `Literal[value=/${GITHUB_REPOSITORY_PATTERN.source}/]`,
      message: GITHUB_REPOSITORY_MESSAGE,
    },
    {
      selector: `TemplateElement[value.raw=/${GITHUB_REPOSITORY_PATTERN.source}/]`,
      message: GITHUB_REPOSITORY_MESSAGE,
    },
  ],
};

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    // The pinned upstream. Not ours to edit, and its own repo lints it.
    'vendor/**',
    '**/test-results/**',
    '**/.mermaid-fixtures/**',
  ]),

  // ---------------------------------------------------------------- plain JS
  // tools/ and the two e2e drivers are hand-written .mjs with no build step,
  // so they get the untyped baseline rather than the type-aware one. Bringing
  // them under `checkJs` was measured at 30 errors plus a new @types/jsdom
  // dependency — a typechecking expansion, not a lint one, and its own issue.
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      ...coreCorrectnessRules,
      // Structural boundaries only: tools/ has its own vitest suites, and every
      // .mjs here is a Node script, so the test-scaffolding and browser
      // boundaries would both be wrong.
      ...boundaries(noVendorOutsideLiveOffice, noCrossWorkspaceReachAround, noDeepWorkspaceImport),
    },
  },
  {
    // Drives a real Chromium: the page.evaluate callbacks are browser code
    // living inside a Node script, so both global sets are in scope.
    files: ['apps/web/e2e/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // ------------------------------------------------------- TypeScript, typed
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      // projectService reads each file's nearest tsconfig, so the lint sees
      // exactly the types the workspace's own typecheck sees — including
      // apps/web's solution-style config with its three referenced projects.
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      /**
       * Property-style signatures are checked covariantly under
       * strictFunctionTypes; method shorthand is bivariant, which is how a
       * stub that accepts less than the interface promises slips through. A
       * type-safety rule wearing a style rule's name.
       */
      '@typescript-eslint/method-signature-style': 'error',
      ...boundaries(
        noVendorOutsideLiveOffice,
        noCrossWorkspaceReachAround,
        noDeepWorkspaceImport,
        noTestScaffoldingInProduction,
        noVitestInProduction,
      ),
      ...coreCorrectnessRules,
      ...presetExceptions,
      ...unusedVarsWithUnderscoreEscape,
    },
  },
  {
    // Repo-wide: the point is catching the *next* hardcoded link wherever it
    // turns up, not just in apps/web where the first three did. root.ts is
    // the one legitimate exception — it is the literal's actual source — and
    // TEST_FILES mock or assert that same literal as fixture data, which is
    // not the mistake this rule exists to catch.
    files: ['**/*.{ts,tsx}'],
    ignores: ['services/api/src/root.ts', ...TEST_FILES],
    rules: { ...noHardcodedGithubRepository },
  },

  // ------------------------------------------------------------------ tests
  {
    /**
     * `require-await`, off here and on everywhere else.
     *
     * The rule exists to catch a function that looks asynchronous by accident.
     * In a test `async` is never accidental — it is the declared interface:
     * `vi.fn(async () => new Response(...))` has to match `typeof fetch`, and
     * the renderer harness's `startDevServer`/`createRenderer` fakes have to
     * match members that return promises. The rule cannot see a contextual
     * type, so all 75 of its findings in test files were that, and the two ways
     * to satisfy it — a hand-rolled `Promise.resolve`, or 75 disable comments —
     * both make the code worse.
     *
     * It stays on for source, where it found three handlers whose `async` really
     * was gratuitous.
     */
    files: TEST_FILES,
    rules: {
      '@typescript-eslint/require-await': 'off',
      // A test may import test scaffolding; that is what it is for. Every other
      // boundary still applies here — a test reaching into another workspace by
      // relative path is the same mistake it would be anywhere else.
      ...boundaries(noVendorOutsideLiveOffice, noCrossWorkspaceReachAround, noDeepWorkspaceImport),
    },
  },

  // --------------------------------------------------------------- apps/web
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
  {
    // `ignores` rather than ordering: no-restricted-imports does not merge, so
    // without it this block would put the production-only boundaries back on
    // apps/web's own test files.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    rules: {
      ...boundaries(
        noVendorOutsideLiveOffice,
        noCrossWorkspaceReachAround,
        noDeepWorkspaceImport,
        noTestScaffoldingInProduction,
        noVitestInProduction,
        noNodeBuiltinsInTheSpa,
      ),
    },
  },
  {
    /**
     * The one place the vendored upstream may be imported from `src`.
     *
     * This directory is the whole reason apps/web has three TypeScript projects
     * rather than one: `tsconfig.live-office.json` compiles these files together
     * with vendor sources at reduced strictness, and `tsconfig.app.json` excludes
     * it. Keeping the exception exactly this wide is what stops the strict
     * project from acquiring vendor types by accident.
     */
    files: ['apps/web/src/live-office/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    rules: {
      ...boundaries(
        noCrossWorkspaceReachAround,
        noDeepWorkspaceImport,
        noTestScaffoldingInProduction,
        noVitestInProduction,
        noNodeBuiltinsInTheSpa,
      ),
    },
  },
  {
    /**
     * ...except protocol.ts, which is inside live-office but must stay
     * vendor-free: `components/LiveOfficePreview.tsx` imports it, and that file
     * belongs to the strict app project. A vendor type reaching it re-breaks
     * `noUncheckedIndexedAccess` for the whole SPA. This was a comment until now.
     */
    files: ['apps/web/src/live-office/protocol.ts'],
    rules: {
      ...boundaries(
        noVendorOutsideLiveOffice,
        noCrossWorkspaceReachAround,
        noDeepWorkspaceImport,
        noTestScaffoldingInProduction,
        noVitestInProduction,
        noNodeBuiltinsInTheSpa,
      ),
    },
  },
  {
    /**
     * The avatar package's one window onto the vendored upstream.
     *
     * pixatar draws with Pixel Agents' own profile format, wardrobe, renderer
     * and randomizer, so it compiles their sources (at the reduced strictness
     * of packages/pixatar/tsconfig.json, like live-office) and tsup bundles
     * them into its dist. Every vendor import goes through this one module, so
     * the exception is exactly one file wide; the rest of the package, and
     * every consumer of its dist, stays vendor-free.
     */
    files: ['packages/pixatar/src/vendor.ts'],
    rules: {
      ...boundaries(
        noCrossWorkspaceReachAround,
        noDeepWorkspaceImport,
        noTestScaffoldingInProduction,
        noVitestInProduction,
      ),
    },
  },
  {
    // Build-time code in the SPA workspace: Node, not a browser — so no
    // browser boundary, and build/ decodes the vendored sprite assets at build
    // time, which is the second half of the live-office exception.
    files: ['apps/web/{vite,vitest}.config.ts', 'apps/web/build/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      ...boundaries(noCrossWorkspaceReachAround, noDeepWorkspaceImport),
    },
  },
]);
