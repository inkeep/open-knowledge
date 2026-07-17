/**
 * Shared Vitest base config for the Open Knowledge workspace.
 *
 * Per-package configs spread `okVitestBase` and add their own `test.include` /
 * `test.root`. Centralizing three load-bearing choices here keeps them from
 * drifting per package:
 *
 *  - `resolve.conditions` / `ssr.resolve.conditions` pin the `development`
 *    export condition EXPLICITLY. Vite's default condition follows NODE_ENV, so
 *    `NODE_ENV=production` would silently resolve workspace deps to `dist/`
 *    instead of `src/` — tests would then run against stale build output. The
 *    SSR resolver is the operative one for inlined workspace symlinks; the
 *    client-side `resolve.conditions` is set too for safety.
 *  - `resolve.alias['bun:test']` routes every `bun:test` import to the shim.
 *  - `test.setupFiles` installs the `Bun` global facade before any test runs.
 *
 * `import.meta.dir` (bun-only, no trailing slash) is rewritten at transform time
 * to the Node-equivalent directory expression. Node's own `import.meta.dirname`
 * is left untouched — it already resolves natively.
 */
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configDefaults, type Plugin, type ViteUserConfig } from 'vitest/config';

// `pnpm check` fans every package's `test` script plus the app's dom/integration/
// conversion/fidelity tiers through turbo at once — a dozen Vitest processes, each
// with its own fork pool. On a workstation that oversubscribes every core and
// starves the event loop of timing-sensitive suites (real CRDT servers, debounce/
// convergence timers), which flake even though each tier is green in isolation.
// Capping each pool's fork count lets the concurrent tiers share the box. CI runs
// one tier per matrix job on a small runner, so the cap is a deliberate no-op
// there (`CI` set, or few cores) — the per-tier matrix is the authoritative bar.
const cpuCount = availableParallelism();
const boundedMaxForks =
  !process.env.CI && cpuCount >= 8 ? Math.max(1, Math.floor(cpuCount / 4)) : undefined;

// Match `import.meta.dir` only when it is NOT the prefix of a longer property
// (`import.meta.dirname` is native Node and must survive verbatim; a naive
// substring replace would rewrite its `import.meta.dir` head and strand `name`).
const IMPORT_META_DIR = /import\.meta\.dir(?![\w$])/g;

export const importMetaDirPlugin: Plugin = {
  name: 'ok-bun-import-meta-dir',
  enforce: 'pre',
  transform(code: string) {
    // Guard on the bare `import.meta` needle, not the full `.dir` form: this
    // module is self-hosting (a test that imports it runs it through this very
    // transform), and a `.dir`-literal guard would rewrite itself.
    if (!code.includes('import.meta')) return null;
    IMPORT_META_DIR.lastIndex = 0;
    const out = code.replace(IMPORT_META_DIR, '(new URL(".", import.meta.url).pathname.slice(0, -1))');
    return out === code ? null : { code: out, map: null };
  },
};

export const bunTestShimPath = fileURLToPath(new URL('./bun-test-shim.ts', import.meta.url));
export const bunGlobalShimPath = fileURLToPath(new URL('./bun-global-shim.ts', import.meta.url));

export const okVitestBase = {
  plugins: [importMetaDirPlugin],
  resolve: {
    alias: { 'bun:test': bunTestShimPath },
    conditions: ['development'],
  },
  ssr: {
    resolve: {
      conditions: ['development'],
      externalConditions: ['development'],
    },
  },
  test: {
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: [bunGlobalShimPath],
    include: ['**/*.test.ts?(x)'],
    exclude: [...configDefaults.exclude, '**/*.spec.*', '**/*.e2e.*', '**/*.dom.test.tsx'],
    // Vitest 4 flattened the pool sizing knobs to top-level `maxWorkers`/
    // `minWorkers` (the old `poolOptions.forks.maxForks` is a no-op here).
    ...(boundedMaxForks === undefined ? {} : { minWorkers: 1, maxWorkers: boundedMaxForks }),
  },
} satisfies ViteUserConfig;
