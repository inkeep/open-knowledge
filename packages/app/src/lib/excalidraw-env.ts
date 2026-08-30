/**
 * Point Excalidraw at the self-hosted asset tree vendored in via
 * `scripts/copy-excalidraw-assets.mjs` (runs on `predev`/`prebuild`).
 * Without this, the package falls back to its hardcoded
 * `https://esm.sh/@excalidraw/excalidraw@<v>/dist/prod/` URL for every font
 * file — a posture change for a local-first editor: offline users get
 * system-font fallbacks, and every online render ships a request to a
 * third-party CDN we do not otherwise depend on.
 *
 * Side-effect module: import it from EVERY entry point that loads
 * `@excalidraw/excalidraw` (the board doc editor AND the document embed),
 * so the pin is in place regardless of which surface a session touches
 * first — a single module-scope assignment in one lazy editor made the
 * behavior session-order-dependent.
 */

export {};

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

if (typeof window !== 'undefined' && window.EXCALIDRAW_ASSET_PATH === undefined) {
  // Path-absolute URLs break under the packaged desktop renderer's `file://`
  // load — `/excalidraw-assets/` resolves against the filesystem root, so
  // Excalidraw falls back to its esm.sh CDN, the exact posture the vendored
  // asset tree exists to prevent. Same rationale as `base: './'` in
  // vite.config.ts: resolve relative to the loaded document there.
  window.EXCALIDRAW_ASSET_PATH =
    window.location.protocol === 'file:'
      ? new URL('excalidraw-assets/', window.location.href).href
      : '/excalidraw-assets/';
}
