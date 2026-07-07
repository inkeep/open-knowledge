import { resolve } from 'node:path';
import babel from '@rolldown/plugin-babel';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { injectAppVersionEnv } from '../app/src/build/app-version';
import { chromeTokensVitePlugin } from '../app/src/build/chrome-tokens-vite-plugin';
import { RENDERER_DEDUPE } from '../app/vite.dedupe';
import { RENDERER_BABEL_OPTIONS } from '../app/vite.react-babel';

// Inject the app's version onto import.meta.env.VITE_APP_VERSION for the
// Electron renderer bundle — the separate build path the desktop app ships.
// `packages/app/vite.config.ts` covers dev + `ok ui`; this covers the renderer.
injectAppVersionEnv();

/**
 * electron-vite config.
 *
 * Renderer section mirrors `packages/app/vite.config.ts` (React + React Compiler
 * + dedupe list for prosemirror/codemirror/yjs/react) minus its `hocuspocusPlugin`,
 * because Electron's utility process owns Hocuspocus — the renderer just connects
 * to `ws://localhost:<utility-port>/collab` via `window.okDesktop.config.collabUrl`.
 *
 * No `configFile: false` is needed in the renderer block: electron-vite resolves
 * its own config from cwd (the desktop package) and does NOT recurse into
 * `${root}/vite.config.ts` for the renderer. `root: ../app` controls module
 * resolution roots, not config discovery.
 *
 * electron-vite 6.x accepts Vite 8 as a peer dep (no bundled internal copy), so
 * the renderer now runs against the same Vite 8 + rolldown instance as
 * `packages/app`. The renderer Babel pass (React Compiler preset + Lingui
 * macro plugin) shares `RENDERER_BABEL_OPTIONS` with `packages/app/vite.config.ts`
 * — see `packages/app/vite.react-babel.ts`.
 */

const appRoot = resolve(__dirname, '../app');

// The Lingui macro resolves `lingui.config.ts` relative to cwd. electron-vite
// runs from `packages/desktop`, so without this the renderer Babel pass fails
// with "Lingui was unable to find a config!". Point it at the app's config —
// the renderer source IS `packages/app`. (`packages/app`'s own vite.config.ts
// needs no equivalent: `bun run dev`/`build` already run with that cwd.)
process.env.LINGUI_CONFIG ??= resolve(appRoot, 'lingui.config.ts');

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      sourcemap: 'hidden',
      rollupOptions: {
        // Two entries in the main bundle: the main-process entry itself AND
        // the utility-process entry that main.forks. electron-vite's config
        // only has `main`/`preload`/`renderer` sections — there is no native
        // `utility` slot — so we piggyback on main. `entryFileNames` uses the
        // input key as a path pattern (`utility/server-entry` → that nested
        // filename), which matches main.index.ts's `join(__dirname,
        // '../utility/server-entry.js')` load path: main lands at
        // `out/main/index.js` and utility at `out/main/utility/server-entry.js`,
        // so `../utility/...` from `out/main/index.js` resolves up one + back
        // into the same folder. Alternative: multi-root rollup config — not
        // worth the complexity for a single extra entry.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'utility/server-entry': resolve(__dirname, 'src/utility/server-entry.ts'),
          'utility/pty-host': resolve(__dirname, 'src/utility/pty-host.ts'),
        },
        output: { format: 'es', entryFileNames: '[name].js' },
      },
    },
    resolve: {
      alias: {
        '@/shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  preload: {
    build: {
      sourcemap: 'hidden',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // CommonJS, not ESM. Electron's sandboxed preload (webPreferences.sandbox: true,
        // our locked default) only supports CommonJS — ESM preloads require
        // sandbox: false and are an Electron 28+ feature with different ABI. Emitting
        // `cjs` produces `out/preload/index.js` (matches `preload:` path in main/index.ts)
        // and works under our sandbox. Without this, Electron silently fails to load
        // the preload script and `window.okDesktop` is never populated — renderer
        // falls into the web-mode branch and the Navigator never appears.
        // `entryFileNames: '[name].js'` overrides electron-vite's default `.cjs`/`.mjs`
        // suffixing so main's `join(__dirname, '../preload/index.js')` load path works
        // without having to special-case the extension.
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: appRoot,
    plugins: [
      // Substitutes __OK_CHROME_BG_LIGHT__ / __OK_CHROME_BG_DARK__ placeholders
      // in app/index.html with sRGB hex resolved from globals.css `--sidebar`.
      // Same plugin used by packages/app/vite.config.ts so dev (`bun run dev`)
      // and electron renderer build resolve identically.
      chromeTokensVitePlugin({ globalsCssPath: resolve(appRoot, 'src/globals.css') }),
      react(),
      // Lingui macro + React Compiler share one Babel pass, options shared
      // with `packages/app/vite.config.ts` via `RENDERER_BABEL_OPTIONS`.
      // `await` is required here: electron-vite deep-clones the renderer
      // config and chokes on the non-plain preset object —
      // https://github.com/alex8088/electron-vite/issues/902
      await babel(RENDERER_BABEL_OPTIONS),
    ],
    resolve: {
      alias: {
        '@': resolve(appRoot, 'src'),
      },
      // Single source of truth — see `packages/app/vite.dedupe.ts` for
      // the full rationale and entry list. Both vite configs (web/dev
      // path AND Electron renderer path) import from the same module,
      // structurally eliminating the silent-divergence path that the
      // prior duplicated array invited. Entries propagate from the
      // shared module without manual mirror.
      dedupe: [...RENDERER_DEDUPE],
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      sourcemap: 'hidden',
      rollupOptions: {
        input: resolve(appRoot, 'index.html'),
      },
    },
    server: {
      // Vite's HMR shouldn't watch content/ — Hocuspocus owns those writes.
      // Inherited from packages/app's config for consistency. Playwright
      // artifacts get the same treatment: the renderer root is packages/app,
      // so a test run writing playwright-report/ there force-reloads the live
      // desktop window (which can land blank).
      watch: {
        ignored: ['**/content/**', '**/playwright-report/**', '**/test-results/**'],
      },
    },
  },
});
