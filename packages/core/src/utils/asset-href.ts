/**
 * Rewrite a server-absolute asset `src` onto the desktop utility server's origin.
 *
 * Markdown image / video / audio / download URLs are normalized to a
 * server-absolute `/<contentDir-relative>` shape (see `normalizeDocRelativeAssetUrl`
 * and `handlers.wikiLinkEmbed`). In the browser dev server that resolves
 * correctly against the page origin (the Vite plugin mounts the asset
 * middleware there). In the Electron renderer the page is a Vite dev URL with
 * no asset middleware, or a `file://` path inside the desktop bundle with no
 * server at all — so `/<rel>` resolves against the wrong base. The Electron
 * utility process exposes the content-asset surface on
 * `window.okDesktop.config.apiOrigin`; prefixing that makes the browser's
 * native `<img>` / `<video>` / `<a download>` loader hit it.
 *
 * In web / CLI builds `window.okDesktop` is undefined → no-op. Scheme'd,
 * relative, and empty srcs pass through untouched. This is a loose runtime
 * read of the same global `client-fetch.ts` reads — core stays free of
 * desktop type imports (browser+Node compatible, no React/server deps).
 */
export function toDesktopAssetHref(src: string): string {
  if (typeof src !== 'string' || !src.startsWith('/')) return src;
  const origin = (globalThis as { window?: { okDesktop?: { config?: { apiOrigin?: unknown } } } })
    .window?.okDesktop?.config?.apiOrigin;
  return typeof origin === 'string' && origin ? origin + src : src;
}
