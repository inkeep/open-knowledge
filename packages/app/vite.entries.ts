import { resolve } from 'node:path';

/**
 * Shared HTML-entry map for the renderer's Vite configs.
 *
 * **Single source of truth** — `packages/app/vite.config.ts` (web / `ok ui` /
 * dev path) and `packages/desktop/electron.vite.config.ts` (Electron renderer
 * path) BOTH build their `build.*Options.input` from this map. Same rationale
 * as `vite.dedupe.ts` and `vite.react-babel.ts`: a new entry is declared once
 * and both builds pick it up, so the two configs cannot drift.
 *
 * Drift here is silent and only bites in packaged builds. The two builds feed
 * different consumers:
 *
 *   - `packages/app`'s own `vite build` → `dist/` → copied to
 *     `packages/cli/dist/public/` → shipped as `<Resources>/app/` by
 *     electron-builder. **This is what a packaged window loads.**
 *   - `packages/desktop`'s `electron-vite build` → `out/renderer/` — the
 *     unpackaged-dev fallback main uses when `ELECTRON_RENDERER_URL` is unset.
 *
 * An entry added to only one config therefore works in dev and 404s in the
 * shipped app.
 *
 * Entries are **flat siblings at the app root**, never nested in a
 * subdirectory: Vite emits shared assets to `<outDir>/assets/`, so every
 * entry HTML must sit at the same depth for the emitted relative `./assets/…`
 * URLs to resolve from all of them under `file://`.
 */
export const RENDERER_HTML_ENTRIES = {
  index: 'index.html',
  uninstall: 'uninstall.html',
} as const satisfies Record<string, `${string}.html`>;

export type RendererEntryName = keyof typeof RENDERER_HTML_ENTRIES;

/**
 * Absolute `rollupOptions.input` map for a renderer build rooted at `appRoot`.
 *
 * The `Record<RendererEntryName, …>` return type is load-bearing: adding a key
 * to `RENDERER_HTML_ENTRIES` fails typecheck here until it is wired in, which
 * is what keeps the map and the input in lockstep.
 */
export function rendererHtmlInput(appRoot: string): Record<RendererEntryName, string> {
  return {
    index: resolve(appRoot, RENDERER_HTML_ENTRIES.index),
    uninstall: resolve(appRoot, RENDERER_HTML_ENTRIES.uninstall),
  };
}
