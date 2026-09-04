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
 *  - `test.setupFiles` installs the `Bun` global facade and the hermetic-test
 *    network guard (`no-net-connect.ts`) before any test runs.
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
    // Rewrite to Node's NATIVE `import.meta.dirname`, not to a URL expression.
    //
    // The previous target — `new URL(".", import.meta.url).pathname.slice(0, -1)`
    // — is a URL PATHNAME, which is only accidentally a filesystem path, and only
    // on POSIX. On Windows it yields `/C:/repo/packages/server/src`: a leading
    // slash and forward separators. Passing that to `spawnSync({cwd})` fails
    // ENOENT, and any `path` operation against it silently produces nonsense.
    // Verified on a Windows 11 ARM64 VM: it is what made
    // `git-preflight-spawn.test.ts` report exit 0 instead of 78 (the subprocess
    // never launched).
    //
    // `import.meta.dirname` is native from Node 20.11 (this repo pins 24), is
    // already correct on every platform, and is exactly what the bun-only
    // `import.meta.dir` means. The regex deliberately does not match
    // `import.meta.dirname`, and `String.replace` never re-scans its own
    // output, so rewriting to that form cannot loop.
    const out = code.replace(IMPORT_META_DIR, 'import.meta.dirname');
    return out === code ? null : { code: out, map: null };
  },
};

const bunGlobalShimPath = fileURLToPath(new URL('./bun-global-shim.ts', import.meta.url));

const noNetConnectPath = fileURLToPath(new URL('./no-net-connect.ts', import.meta.url));

// A project's `setupFiles` must be the base array: either spread into a new one
// (`[...okVitestBase.test.setupFiles, mine]`) or handed straight through. Not a
// hand-listed array, not one entry picked out of the base, not a filtered copy —
// each of those silently drops whichever guard the author left out, and the loss
// is invisible because the tests still pass. The two paths above stay unexported
// so the hand-rolled spelling is not reachable from outside this module, and
// `setup-files-contract.test.ts` imports every vitest project's config and fails
// any whose RESOLVED array omits an entry this base installs, so no spelling can
// route around it.

export const okVitestBase = {
  plugins: [importMetaDirPlugin],
  resolve: {
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
    // The skills.sh install report honors the standard opt-out vars. Setting one
    // here means no test run — local or CI — can report an install it did not
    // make, and no suite depends on reaching a third-party host to pass. A test
    // that wants to exercise the reporter injects its own `fetchImpl` and
    // `env`, so this never hides the behavior under test.
    env: { DO_NOT_TRACK: '1' },
    setupFiles: [bunGlobalShimPath, noNetConnectPath],
    include: ['**/*.test.ts?(x)'],
    exclude: [...configDefaults.exclude, '**/*.spec.*', '**/*.e2e.*', '**/*.dom.test.ts?(x)'],
    // Vitest 4 flattened the pool sizing knobs to top-level `maxWorkers`/
    // `minWorkers` (the old `poolOptions.forks.maxForks` is a no-op here).
    ...(boundedMaxForks === undefined ? {} : { minWorkers: 1, maxWorkers: boundedMaxForks }),
  },
} satisfies ViteUserConfig;
