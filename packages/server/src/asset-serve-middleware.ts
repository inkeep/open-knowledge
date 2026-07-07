/**
 * Middleware that serves contentDir assets via sirv with a
 * Content-Disposition policy and a fail-closed 404 guard.
 *
 * Both surfaces consume this single implementation:
 *   - `bun run dev` Vite plugin (combines Vite + collab + asset serving
 *     on one port) — `packages/app/src/server/hocuspocus-plugin.ts`.
 *   - `ok ui` production server — `packages/cli/src/commands/ui.ts`.
 *
 * Extracted as a pure factory so it can be unit-tested without spinning
 * up an HTTP server. The consumer supplies the real `contentFilter` +
 * sirv instance; tests supply stubs (unit tier) or a real filter + sirv
 * against a tmpdir (narrow-integration tier).
 *
 * Policy:
 *   1. Fall through to `next()` (so the next middleware — Vite's static
 *      serve, then SPA fallback — can handle the URL) when EITHER:
 *      (a) the content filter marks the path ignored (`isPathIgnored` —
 *      `.gitignore` / `.okignore` patterns, `BUILTIN_SKIP_DIRS` segments
 *      like `node_modules/` / `dist/` / `.git/`, reserved system-doc names);
 *      load-bearing for `/node_modules/...` / `/dist/...` Vite-internal
 *      paths. (b) the extension is not servable content — i.e. not `.md` /
 *      `.mdx` and not a known content-asset extension. Streaming an
 *      arbitrary contentDir file (`.exe`, extensionless, ...) is the
 *      stored-XSS / RCE-class hole this branch closes. (`.html`/`.htm` ARE
 *      admitted, but only under the `SANDBOXED_HTML_CSP` opaque origin — see
 *      the sandbox branch below.)
 *
 *      We use `isPathIgnored`, NOT `isExcluded`, for (a) — `isExcluded`
 *      additionally applies the sibling-asset heuristic (an asset is
 *      "excluded" unless its directory holds an included `.md`), which is a
 *      file-watcher index-walk concern, not a serve-path concern. Doc-
 *      referenced assets routinely live in a dedicated `assets/` tree with no
 *      sibling `.md` (`![](../../assets/images/foo.png)`); gating serving on
 *      the sibling heuristic 404s them. `isExcluded`'s default-→-exclude
 *      branch ALSO did the (b) job, so we restore it explicitly here. Mirrors
 *      `handleAsset` / `collectReferencedAssets` in `api-extension.ts`, which
 *      already use `isPathIgnored` for the same reason.
 *   2. Always set `X-Content-Type-Options: nosniff`.
 *   3. For `.md` / `.mdx` direct-URL requests: skip Content-Disposition
 *      dispatch entirely. Normal editor flow uses hash routing; forcing
 *      `attachment` would break dev-tool `curl` of markdown paths.
 *   4. For inline-renderable extensions (images, PDF, video, audio):
 *      `Content-Disposition: inline` → browser renders in the new-tab
 *      built-in viewer.
 *   5. For everything else admitted by the content filter (office docs,
 *      archives, fonts, tabular/text data): `Content-Disposition:
 *      attachment` → browser prompts download rather than rendering
 *      ambiguously. Aligns with HedgeDoc's GHSA-x74j-jmf9-534w posture.
 *   6. sirv fall-through (file not found on disk) for asset-extension
 *      or executable-blocklist paths → explicit `404` BEFORE calling
 *      `next()`. Prevents Vite's `htmlFallbackMiddleware` (or sirv's
 *      `single: true` SPA fallback in `ok ui`) from returning
 *      `index.html` as `text/html` for missing asset URLs.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { SANDBOXED_HTML_CSP, SANDBOXED_HTML_EXTENSIONS } from '@inkeep/open-knowledge-core';
import { mimes } from 'mrmime';

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

/**
 * Minimal contract the middleware depends on. The real
 * `@inkeep/open-knowledge-server` ContentFilter satisfies this; tests can
 * pass a stub.
 *
 * `isPathIgnored` (not `isExcluded`) is the right predicate — it is the
 * security-boundary-only check (`.gitignore` / `.okignore` / `BUILTIN_SKIP_DIRS`
 * / reserved system docs) without the sibling-asset admission heuristic, so
 * a referenced asset in a dedicated `assets/` directory with no sibling `.md`
 * is still servable. See the module doc-block, policy item 1.
 */
export interface AssetServeFilter {
  isPathIgnored(relativePath: string): boolean;
}

/**
 * Sirv-shaped middleware. The real `sirv(contentDir, {...})` result
 * satisfies this signature; tests can pass a stub that synchronously
 * invokes the fallback to simulate a file-not-found.
 */
export type SirvLikeMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  fallback: () => void,
) => void;

interface AssetServeMiddlewareDeps {
  /** Content filter (from `createServer()`'s returned `ServerInstance`). */
  contentFilter: AssetServeFilter;
  /** Sirv instance over the content directory. */
  contentSirv: SirvLikeMiddleware;
  /** Extensions that render safely inline in the browser. */
  inlineExtensions: ReadonlySet<string>;
  /**
   * Extensions admitted for asset-serve. Sirv fall-through for these
   * returns 404 (rather than falling through to Vite's SPA fallback).
   */
  assetExtensions: ReadonlySet<string>;
  /**
   * Executable-class extensions. Sirv fall-through for these also
   * returns 404 — mirrors the main-process `openAssetSafely` blocklist
   * so the serve surface refuses what the click surface refuses.
   */
  blocklistExtensions: ReadonlySet<string>;
}

export function createAssetServeMiddleware(
  deps: AssetServeMiddlewareDeps,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const { contentFilter, contentSirv, inlineExtensions, assetExtensions, blocklistExtensions } =
    deps;

  return (req, res, next) => {
    // Malformed percent-encoding (`/%`, `/%E0%A4`) throws URIError; treat
    // it as a miss and fall through to the SPA handler rather than letting
    // the throw propagate to the http.Server and leave the request hanging.
    let rel: string;
    try {
      rel = decodeURIComponent(req.url?.split('?')[0]?.replace(/^\//, '') ?? '');
    } catch {
      return next();
    }
    const ext = extname(rel).slice(1).toLowerCase();
    const isDocExt = ext === 'md' || ext === 'mdx';
    // Bail (→ next()) when: the path is empty, the content filter marks it
    // ignored (security boundary — see policy item 1), OR it is not a servable
    // content extension. "Servable" = `.md` / `.mdx` (streamed raw — the editor
    // fetches via the API, but a direct curl shouldn't force-download) or a
    // known content-asset extension. Anything else (`.html`, `.exe`, extension-
    // less paths, arbitrary unknown extensions) must NOT stream a contentDir
    // file — that's the stored-XSS / RCE-class defense the `ContentFilter`'s
    // "default → exclude" branch provided, which `isPathIgnored` (used
    // here to skip the sibling-asset heuristic) does not. A blocklisted
    // extension that is *also* an asset extension (`.svg` — barred from the
    // openAsset click path by `EXECUTABLE_BLOCKLIST_EXTENSIONS` yet a legitimate
    // `<img src>` source) still serves: it's in `INLINE_RENDERABLE_EXTENSIONS`
    // so it gets `inline` disposition, which is safe for `<img>` embeds (those
    // don't execute SVG scripts) but NOT for a top-level GET of the SVG URL —
    // hence the CSP sandbox below, matching `handleAsset`.
    if (!rel || contentFilter.isPathIgnored(rel) || (!isDocExt && !assetExtensions.has(ext)))
      return next();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // `html`/`htm` are admitted to ASSET_EXTENSIONS (so author-created HTML
    // resolves + serves) but deliberately kept OUT of INLINE_RENDERABLE_EXTENSIONS.
    // They render inline ONLY inside the sandbox CSP below — never as a plain
    // same-origin document.
    const isSandboxedHtml = SANDBOXED_HTML_EXTENSIONS.has(ext);
    if (!isDocExt) {
      if (inlineExtensions.has(ext) || isSandboxedHtml) {
        res.setHeader('Content-Disposition', 'inline');
      } else {
        res.setHeader('Content-Disposition', 'attachment');
      }
    }
    // SVG served inline executes embedded `<script>` on a top-level navigation
    // — `nosniff` doesn't help (`image/svg+xml` is CORB-excluded). Match the CSP
    // sandbox `handleAsset` (api-extension.ts) applies so `GET /<rel>.svg` can't
    // run scripts; the editor's `<img src>` render path is unaffected (embeds
    // don't execute SVG).
    if (ext === 'svg') {
      res.setHeader(
        'Content-Security-Policy',
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      );
    } else if (isSandboxedHtml) {
      res.setHeader('Content-Security-Policy', SANDBOXED_HTML_CSP);
      // Match `/api/asset`'s no-store posture so an edited/removed sandboxed
      // document doesn't linger in the browser cache.
      res.setHeader('Cache-Control', 'no-store');
    }
    contentSirv(req, res, () => {
      // If sirv already wrote the response (it shouldn't normally call
      // fallback after writing headers, but guard defensively), don't
      // double-handle — the response is already owned.
      if (res.headersSent) return;
      // `html`/`htm` MISSES fall through to the downstream SPA/static handler
      // rather than fail-closed 404. They share the app shell's `index.html`
      // filename, which lives in the SPA bundle (dist/), NOT contentDir — a
      // 404 here would strand the shell.
      const isHtml = SANDBOXED_HTML_EXTENSIONS.has(ext);
      if (!isHtml && (assetExtensions.has(ext) || blocklistExtensions.has(ext))) {
        res.statusCode = 404;
        res.end();
        return;
      }
      // Strip the asset-serve headers set above BEFORE the miss was known, so
      // the downstream SPA handler serves the app shell on a clean response.
      // Otherwise `GET /index.html` (a miss in contentDir) would carry
      // `Content-Security-Policy: sandbox …` and drop the editor shell into an
      // opaque origin where its API / WebSocket / storage all fail.
      if (isHtml) {
        res.removeHeader('Content-Security-Policy');
        res.removeHeader('Content-Disposition');
        res.removeHeader('X-Content-Type-Options');
        res.removeHeader('Cache-Control');
      }
      next();
    });
  };
}
