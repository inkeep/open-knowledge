import { extname } from 'node:path';
import { SANDBOXED_HTML_CSP, SANDBOXED_HTML_EXTENSIONS } from '@inkeep/open-knowledge-core';
import { mimes } from 'mrmime';

/**
 * The one extension → disposition/CSP policy for serving content assets.
 * Both serve surfaces (`/api/asset` and the static content middleware) apply
 * this identically; before this module each reimplemented it by hand with a
 * "mirrors the other" comment as the only sync mechanism.
 *
 * `html`/`htm` render inline ONLY under the sandbox CSP — they are
 * deliberately absent from INLINE_RENDERABLE_EXTENSIONS so no branch serves
 * them as a plain same-origin document. SVG inline executes embedded scripts
 * on top-level navigation (`nosniff` doesn't help — `image/svg+xml` is
 * CORB-excluded), hence its own sandbox CSP; `<img>` embeds are unaffected.
 */
export interface AssetDisposition {
  disposition: 'inline' | 'attachment';
  /** Content-Security-Policy to apply, or null when none is required. */
  csp: string | null;
  /** True for the sandboxed-HTML class (callers add no-store cache policy). */
  sandboxedHtml: boolean;
}

export function classifyAssetDisposition(
  ext: string,
  /** Injectable for tests; production callers pass INLINE_RENDERABLE_EXTENSIONS. */
  inlineExtensions: ReadonlySet<string>,
): AssetDisposition {
  const sandboxedHtml = SANDBOXED_HTML_EXTENSIONS.has(ext);
  const disposition = inlineExtensions.has(ext) || sandboxedHtml ? 'inline' : 'attachment';
  const csp =
    ext === 'svg'
      ? "sandbox; default-src 'none'; style-src 'unsafe-inline'"
      : sandboxedHtml
        ? SANDBOXED_HTML_CSP
        : null;
  return { disposition, csp, sandboxedHtml };
}

/**
 * Close 3 gaps in mrmime's default mime table that break browser inline
 * rendering for common user-drop formats. Without these, sirv serves the
 * bytes with an empty `Content-Type` header — combined with our
 * `Content-Disposition: inline` policy, Chromium renders the binary
 * bytes as garbled text rather than dispatching to its built-in video /
 * audio viewer.
 *
 * The fix is documented idiomatic usage per mrmime's README: "Exposes
 * the `mimes` dictionary for easy additions or overrides." Three
 * extensions need coverage:
 *
 *   - `.m4v` → `video/mp4`. Apple's MP4 variant is structurally MP4;
 *     `video/mp4` is standards-recommended (WordPress Trac #24993,
 *     Mozilla bug 875573). mrmime deliberately filters `x-` types, so
 *     the historical `video/x-m4v` is not in its default table.
 *   - `.mkv` → `video/x-matroska`. De-facto type (no IANA registration
 *     exists); Chromium recognizes it. Only non-`x-` alternative would
 *     be `application/octet-stream` which blocks inline rendering.
 *   - `.flac` → `audio/flac`. IANA-registered (RFC 9639);
 *     `audio/x-flac` is the deprecated legacy alias.
 *
 * Security posture: setting extension-derived Content-Type on
 * video/audio with `X-Content-Type-Options: nosniff` is NOT a stored-
 * XSS vector. Browsers refuse to treat `video/*` / `audio/*` as
 * scriptable regardless of file contents under nosniff (MDN
 * X-Content-Type-Options, Beyond XSS ch5). The SVG polyglot class
 * (`image/svg+xml`) is the real risk and is separately covered by
 * `EXECUTABLE_BLOCKLIST_EXTENSIONS` barring `.svg` from the
 * `openAssetSafely` click path.
 *
 * Module-load mutation runs once per Node process. Multiple dev-server
 * invocations in the same process (Vite restart) re-assign idempotently.
 *
 * If a future inline-renderable extension lands without a mrmime entry,
 * the narrow-integration test for `.m4v` will flag it (currently pinned
 * to `video/mp4`). Extend this map in lockstep.
 */
Object.assign(mimes, {
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  flac: 'audio/flac',
  // TOML has an IANA-registered media type (`application/toml`) but
  // `mrmime` doesn't ship it by default — the table is the
  // narrow `mime-db` subset, not the full registry. Without this
  // entry, sirv serves `.toml` with an empty `Content-Type` and our
  // `/api/asset` handler 415s (the `assetContentTypeForPath` lookup
  // returns null). The `TextViewer`'s own fetch path
  // (`/api/asset-text`) forces `text/plain` and is therefore
  // unaffected by this patch — what relies on it is the fallback
  // pane's "Open file" link + any direct deeplink to a `.toml`
  // asset URL. JSON is already covered by mrmime's defaults.
  toml: 'application/toml',
  // `.lock` has no IANA registration and no mrmime default. Same
  // mrmime-gap pattern as `.toml` above; without this, the
  // `INLINE_RENDERABLE_EXTENSIONS` widening for `lock` would 415 on
  // direct `/api/asset?path=foo.lock` GETs. `text/plain` matches
  // what the `TextViewer` path (`/api/asset-text`) already forces,
  // so the sidebar-click and deeplink surfaces agree on the wire
  // shape. Lockfile contents vary across ecosystems (some JSON-
  // shaped, some custom DSLs) but `text/plain` is the right floor.
  lock: 'text/plain',
  // Attachment-only types newly admitted to ASSET_EXTENSIONS that `mrmime`'s
  // default table omits. Without an entry, `assetContentTypeForPath` returns
  // null and `handleAsset` 415s them (and sirv streams them with an empty
  // Content-Type). All download-only — none are inline-renderable.
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  rar: 'application/vnd.rar',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  pages: 'application/vnd.apple.pages',
  numbers: 'application/vnd.apple.numbers',
  key: 'application/vnd.apple.keynote',
  mobi: 'application/x-mobipocket-ebook',
});

export function assetContentTypeForPath(path: string): string | null {
  return mimes[extname(path).slice(1).toLowerCase()] ?? null;
}
