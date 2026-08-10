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
 *   0. Once a request is known to be a content-serve attempt (it survives
 *      the fall-through checks in item 1), it must pass the shared ingress
 *      peer + Host predicates — the read half of the DNS-rebinding defense
 *      for the static surface, mirroring the `/api` pipeline's read gate. A
 *      rebound page (loopback TCP peer, attacker-controlled Host) is
 *      refused BEFORE any disk read. What is gated is exactly the
 *      content-serve set: `.md`/`.mdx` and every `ASSET_EXTENSIONS` member —
 *      which INCLUDES `.html`/`.htm` (author HTML is servable content). The
 *      extension-LESS SPA-shell path (`GET /`, deep-links) and Vite-owned
 *      URLs fall through UNGATED (item 1's not-a-servable-extension bail):
 *      the shell is public bundle code and a rebound attacker serves their
 *      own page anyway, so gating it risks breaking legitimate loads for
 *      zero security gain. One caveat: `ok ui` rewrites `GET /` to
 *      `/index.html` BEFORE this middleware, so its shell root IS gated
 *      here — acceptable because `ok ui` is a loopback-only sidecar (its
 *      `/api` gate admits loopback Hosts only); the exposable surface is
 *      `ok start`, where `GET /` stays extension-less and ungated. Origin is
 *      intentionally NOT checked — no-cors `<img>` / CSS loads omit it, and
 *      the Host check alone closes the rebinding content-exfil vector.
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
import { SANDBOXED_HTML_EXTENSIONS } from '@inkeep/open-knowledge-core';
import { errorResponse } from './http/error-response.ts';
import {
  HOST_NOT_ADMITTED_REMEDIATION,
  type IngressPolicy,
  isHostAdmitted,
  isPeerAdmitted,
} from './ingress-policy.ts';
import { classifyAssetDisposition } from './services/asset-classification.ts';

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
  /**
   * The boot-built ingress policy driving the content-serve peer + Host
   * gate (policy item 0). Required — every consumer supplies the one
   * policy its surface runs under, so a new serve surface cannot silently
   * skip the gate. Surfaces without a resolved runtime (the Vite dev
   * plugin) pass the loopback-only default (`buildIngressPolicy({})`).
   */
  ingressPolicy: IngressPolicy;
}

export function createAssetServeMiddleware(
  deps: AssetServeMiddlewareDeps,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const {
    contentFilter,
    contentSirv,
    inlineExtensions,
    assetExtensions,
    blocklistExtensions,
    ingressPolicy,
  } = deps;

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
    // Content-serve gate (policy item 0). Fires before any header or disk
    // work so a refused request observes nothing — including whether the
    // file exists. A missing socket only occurs on synthetic test requests
    // (matches the `/api` pipeline's convention); the Host check still runs
    // there, so the rebinding defense stays meaningful on every path.
    const peerAddress = req.socket?.remoteAddress;
    if (peerAddress !== undefined && !isPeerAdmitted(peerAddress, ingressPolicy)) {
      errorResponse(res, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
        handler: 'content-asset-gate',
      });
      return;
    }
    if (!isHostAdmitted(req.headers.host, ingressPolicy)) {
      errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
        handler: 'content-asset-gate',
        detail: HOST_NOT_ADMITTED_REMEDIATION,
      });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Shared with `/api/asset`: one extension → disposition/CSP policy for
    // both serve surfaces (rationale lives with the classifier).
    const classified = classifyAssetDisposition(ext, inlineExtensions);
    if (!isDocExt) {
      res.setHeader('Content-Disposition', classified.disposition);
    }
    if (classified.csp !== null) {
      res.setHeader('Content-Security-Policy', classified.csp);
    }
    if (classified.sandboxedHtml) {
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
