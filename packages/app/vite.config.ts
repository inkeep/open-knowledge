import babel from '@rolldown/plugin-babel';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { injectAppVersionEnv } from './src/build/app-version';
import { chromeTokensVitePlugin } from './src/build/chrome-tokens-vite-plugin';
import { rejectionLoopGuardPlugin } from './src/build/rejection-loop-guard-plugin';
import { hocuspocusPlugin } from './src/server/hocuspocus-plugin';
import { RENDERER_DEDUPE } from './vite.dedupe';
import { RENDERER_BABEL_OPTIONS } from './vite.react-babel';

// Inject the app's own version onto import.meta.env.VITE_APP_VERSION for the
// browser bundle (telemetry resource + client-version wire builder). Covers
// both `bun run dev` and the production bundle `ok ui` serves.
injectAppVersionEnv();

const vitePort = process.env.VITE_PORT ? Number.parseInt(process.env.VITE_PORT, 10) : undefined;

// Per-worker Vite optimized-dependency cache dir. Set by the per-worker
// Playwright fixture alongside `VITE_PORT` and `OK_TEST_CONTENT_DIR`, so N
// concurrent dev servers do not share `<root>/node_modules/.vite` — the
// dependency optimizer is single-writer over its cacheDir, and re-optimization
// rewrites chunk hashes mid-flight for any peer worker's browser. Unset
// everywhere else (production `vite build`, plain `bun run dev`) → Vite default.
const viteCacheDir = process.env.OK_TEST_VITE_CACHE_DIR;

export default defineConfig({
  // Relative asset paths — `./assets/foo.js` in the built index.html.
  // Works under both HTTP (`ok ui` serves from root) and `file://` (Electron's
  // `loadFile()` resolves relative to the bundle path). Default `base: '/'`
  // silently broke the packaged renderer: under `file://`, `/assets/foo.js`
  // resolves to the filesystem root and every chunk 404s.
  base: './',
  // `undefined` lets Vite resolve its own default
  // (`<root>/node_modules/.vite`) for non-test paths; the per-worker
  // Playwright fixture overrides via `OK_TEST_VITE_CACHE_DIR`.
  cacheDir: viteCacheDir,
  optimizeDeps: {
    // Scope the dependency scanner to the real app entry. Vite's default
    // entries glob (every `**/*.html`) also picks up
    // `scripts/audit-strings/viewer-template.html`, which wastes scan work
    // and appeared as a scan entry in the CI dep-scan failures ("Failed to
    // run dependency scan … The server is being restarted or closed").
    entries: ['index.html'],
  },
  // Default Vite envPrefix is `VITE_` only — keep it that way. The cold-mount
  // PROD-build override lives at `VITE_OK_PERF_INSTRUMENT` (alongside the
  // other `VITE_OK_PERF_*` rollout flags) so no custom prefix entry is
  // needed; that mechanically prevents the startsWith() namespace leak that
  // an `OK_PERF_INSTRUMENT` prefix would have. New client-exposed perf
  // controls follow the same `VITE_OK_PERF_*` convention.
  plugins: [
    // `rejectionLoopGuardPlugin` self-gates to `apply: 'serve'` and injects
    // an inline script at `head-prepend` so its `unhandledrejection`
    // listener registers before `@vite/client`. See the plugin's docblock
    // for the loop it breaks.
    rejectionLoopGuardPlugin(),
    chromeTokensVitePlugin(),
    react(),
    // Single Babel pass — Lingui macro (plugin) + React Compiler (preset).
    // See `vite.react-babel.ts` for the plugin-before-preset rationale; the
    // options are shared with the Electron renderer build.
    babel(RENDERER_BABEL_OPTIONS),
    hocuspocusPlugin(),
  ],
  resolve: {
    tsconfigPaths: true,
    // Single source of truth — see `./vite.dedupe.ts` for the full
    // rationale (prosemirror dual-instance, React hook identity, yjs
    // import-guard + dual prosemirror-binding-stack identity-mismatch).
    // The same array drives `packages/desktop/electron.vite.config.ts`'s
    // renderer block, so a new entry added here propagates without
    // manual mirror.
    dedupe: [...RENDERER_DEDUPE],
  },
  server: {
    port: vitePort ?? 5173,
    strictPort: vitePort !== undefined,
    watch: {
      // Exclude the content/ directory from Vite's HMR watcher.
      // Markdown files here are managed by the Hocuspocus file watcher + persistence
      // layer. Letting Vite HMR also watch them causes a full page reload on every
      // persistence write, which drops in-flight typing and jumps the cursor.
      // Playwright artifacts get the same treatment: a test run writing
      // playwright-report/index.html force-reloads every connected dev window
      // (including a live OK Desktop renderer), which can land blank.
      ignored: ['**/content/**', '**/playwright-report/**', '**/test-results/**'],
    },
  },
  build: {
    // Largest chunk today is ~1.13 MB pre-gzip (≈350 kB gzipped). The bundle
    // is the editor + collab stack + every shadcn primitive — known-large by
    // construction. Bump just above current ceiling so the advisory still
    // catches a future regression but doesn't fire on every clean build.
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      // Filter known false-positive warnings. Re-evaluate when bumping
      // rolldown / vite. Anything not matched falls through to default.
      onLog(level, log, defaultHandler) {
        // `@protobufjs/inquire` uses `eval("quire".replace(/^/,"re"))(name)`
        // as a deliberate require-detection workaround for bundlers. Reaches
        // us transitively via @opentelemetry/otlp-transformer (every OTLP
        // exporter). Cannot be patched at source.
        if (
          log.code === 'EVAL' &&
          typeof log.id === 'string' &&
          log.id.includes('/@protobufjs/inquire/')
        ) {
          return;
        }
        // PLUGIN_TIMINGS is an informational performance breakdown; the bulk
        // (84%) is @rolldown/plugin-babel for the React Compiler pass, which
        // is intentional and not actionable from this side.
        if (log.code === 'PLUGIN_TIMINGS') {
          return;
        }
        defaultHandler(level, log);
      },
    },
  },
});
