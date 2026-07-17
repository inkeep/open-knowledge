import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { appVitestConfig } from './vitest.config';

// Tier-3 DOM project: the `*.dom.test.tsx` React-runtime suite. A dedicated
// vitest project with the jsdom environment and per-file isolation, replacing
// the invocation-scoped `bun test --isolate --preload ./tests/dom/jsdom-preload.ts`
// chain the retired scripts/run-test-dom.sh carried. Everything else (lingui
// macro shim, single-instance dedupe, development-conditions pin, Bun global
// facade, per-test IDB reset) is inherited from the app base config.
//
// `environment: 'jsdom'` installs the DOM globals declaratively per project, so
// the unit / conversion / fidelity / integration projects stay node-env with no
// jsdom bleed. `tests/dom/jsdom-preload.ts` is carried as a per-project
// setupFile that backfills the handful of globals jsdom omits (matchMedia,
// ResizeObserver, scrollIntoView, MessageChannel).
//
// `isolate: true` (the forks-pool default, pinned explicitly) gives each file a
// fresh module registry so a `mock.module(...)` in one .dom.test.tsx cannot leak
// into the next — the parity-critical property the retired `--isolate` flag
// provided (oven-sh/bun#12823).
const jsdomSetupPath = fileURLToPath(new URL('./tests/dom/jsdom-preload.ts', import.meta.url));

export const appDomVitestConfig = {
  ...appVitestConfig,
  test: {
    ...appVitestConfig.test,
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'http://localhost:5173', pretendToBeVisual: true },
    },
    include: ['**/*.dom.test.tsx'],
    // The base config excludes `**/*.dom.test.tsx` so the unit tier stays
    // no-DOM; this is the one project that runs them, so drop that single
    // exclusion while keeping node_modules / .spec / .e2e out.
    exclude: appVitestConfig.test.exclude.filter((pattern) => pattern !== '**/*.dom.test.tsx'),
    setupFiles: [...appVitestConfig.test.setupFiles, jsdomSetupPath],
    // Per-test budget carried over from the bun `--timeout 30000`. Declared
    // literally (not only inherited) so the CI test-coverage meta-guard reads it
    // directly off this config.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    isolate: true,
  },
} satisfies ViteUserConfig;

export default defineConfig(appDomVitestConfig);
