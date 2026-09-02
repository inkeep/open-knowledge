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
// fresh module registry so a `vi.doMock(...)` in one .dom.test.tsx cannot leak
// into the next — the parity-critical property the retired `--isolate` flag
// provided (oven-sh/bun#12823).
const jsdomSetupPath = fileURLToPath(new URL('./tests/dom/jsdom-preload.ts', import.meta.url));

export const appDomVitestConfig = {
  ...appVitestConfig,
  resolve: {
    ...appVitestConfig.resolve,
    alias: [
      ...appVitestConfig.resolve.alias,
      // Excalidraw's dev bundle imports `roughjs/bin/rough` without the
      // extension, which Vite's Node resolver rejects. The browser build
      // resolves it through bundling, so this only bites the one tier that
      // imports the real package rather than stubbing it
      // (`excalidraw-scene.roundtrip.dom.test.ts`). Drop this alias if a
      // future Excalidraw ships the extension.
      { find: /^roughjs\/bin\/rough$/, replacement: 'roughjs/bin/rough.js' },
    ],
  },
  test: {
    ...appVitestConfig.test,
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'http://localhost:5173', pretendToBeVisual: true },
    },
    // `.tsx` mounts React; `.ts` is the same jsdom tier for DOM-only tests
    // that never render a component (shadow-root helpers, for instance).
    include: ['**/*.dom.test.ts?(x)'],
    // The base config excludes `**/*.dom.test.tsx` so the unit tier stays
    // no-DOM; this is the one project that runs them, so drop that single
    // exclusion while keeping node_modules / .spec / .e2e out.
    exclude: appVitestConfig.test.exclude.filter((pattern) => pattern !== '**/*.dom.test.ts?(x)'),
    setupFiles: [...appVitestConfig.test.setupFiles, jsdomSetupPath],
    // Per-test budget carried over from the bun `--timeout 30000`. Declared
    // literally (not only inherited) so the CI test-coverage meta-guard reads it
    // directly off this config.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    isolate: true,
    // Route the real Excalidraw through Vite's transform rather than Node's
    // resolver, so the `roughjs/bin/rough` alias above is honoured. Only the
    // round-trip suite imports the package for real; every other Excalidraw
    // test stubs it via `vi.doMock`, which intercepts ahead of resolution.
    server: { deps: { inline: [/@excalidraw[/\\]excalidraw/] } },
  },
} satisfies ViteUserConfig;

export default defineConfig(appDomVitestConfig);
