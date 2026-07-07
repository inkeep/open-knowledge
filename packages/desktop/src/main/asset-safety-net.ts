/**
 * Main-process defense-in-depth for asset clicks that bypass the renderer
 * dispatcher.
 *
 * The renderer-side `dispatchAssetClick` handles the happy path — every
 * click on a wikiembed `<a>` or an asset-classified link mark routes
 * through it. But clicks can escape:
 *
 *   - Drop-time `<a target="_blank">` renderHTML on the transient
 *     WikiLinkEmbed node (post-save shape differs). The `target="_blank"`
 *     means Electron fires `setWindowOpenHandler` for the new-window
 *     request; we intercept, deny, and delegate to OS.
 *   - Pasted raw `<a href="http://localhost:<port>/notes/foo.pdf">` from
 *     another app's clipboard. Click fires `will-navigate` on the editor's
 *     webContents; we intercept, preventDefault, and delegate to OS.
 *   - Future plugin content that emits `<a>` without wiring into the
 *     dispatcher.
 *
 * Two-handler pattern:
 * `setWindowOpenHandler` covers NEW-window requests, `will-navigate`
 * covers IN-PAGE navigations. Electron docs recommend both as the
 * canonical defense; Standard Notes + AFFiNE + VSCode all implement
 * both.
 *
 * Pure-ish: takes a narrow `WebContentsLike` so tests can exercise the
 * dispatch logic without standing up Electron. `openAssetSafely` is
 * injected — the real wiring in `index.ts` passes the main-process gate
 * with the caller window's `ProjectContext.projectPath`.
 */

import { ASSET_EXTENSIONS } from '@inkeep/open-knowledge-core';
import type { AssetOpenResult } from './asset-allowlist.ts';

/**
 * Narrow webContents type — the subset `attachAssetSafetyNet` uses.
 * Matches Electron's `WebContents` at runtime but lets tests inject
 * a fake without pulling the full `electron` module into test-land.
 */
interface WebContentsLike {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void;
  on(
    event: 'will-navigate',
    handler: (event: { preventDefault: () => void }, url: string) => void,
  ): void;
  /**
   * The renderer's current URL. Used to recognize same-renderer-origin in-app
   * routes (`#/doc`), whose origin is distinct from `editorOrigin` in dev (the
   * renderer is served from `rendererDevUrl`, e.g. http://localhost:5173, while
   * `editorOrigin` is the separate utility/API port). Electron's WebContents
   * always provides this; optional so test fakes that don't exercise in-app
   * routing can omit it — the net then leaves such URLs on the external path
   * (the pre-fix behavior).
   */
  getURL?(): string;
  /**
   * Run JS in the renderer. Used to drive same-origin in-app navigation when a
   * `_blank` open targets an internal route (the desktop shell has no OS tab).
   * Optional for the same reason as `getURL`.
   */
  executeJavaScript?(code: string): Promise<unknown>;
}

interface AttachAssetSafetyNetDeps {
  /** Runs the authoritative main-process gate (containment + blocklist). */
  readonly openAsset: (relPath: string) => Promise<AssetOpenResult>;
  /**
   * Delegate a cross-origin URL to the OS default browser. Wired in
   * `index.ts` to the same `handleShellOpenExternal` factory that backs
   * `ok:shell:open-external`, so the scheme allowlist is enforced once.
   * Throws on disallowed schemes — caller catches.
   *
   * Without this, any URL the renderer routes through `window.open` (the
   * markdown link PropPanel's "Open in new tab", a stray `<a target=_blank>`
   * whose onClick handler didn't run, etc.) gets denied at
   * `setWindowOpenHandler` and the click silently does nothing.
   */
  readonly openExternal: (url: string) => Promise<void>;
  /**
   * Origin the editor serves from — used to distinguish "in-app" asset
   * URLs (which the safety net claims) from external URLs (which go
   * through `openExternal` above).
   * Pass `apiOrigin` from the window's ProjectContext.
   */
  readonly editorOrigin: string;
  /**
   * Optional log hook — defaults to `console.warn` with a structured
   * prefix. Injected so tests can assert on the log + prod can pipe to
   * the main-process logger when that wiring arrives.
   */
  readonly log?: (event: {
    level: 'warn' | 'info';
    message: string;
    data: Record<string, unknown>;
  }) => void;
}

const DEFAULT_LOG: Required<AttachAssetSafetyNetDeps>['log'] = (event) => {
  console.warn(`[asset-safety-net] ${event.message}`, event.data);
};

/**
 * Parse an absolute URL against the editor's origin and extract a
 * project-relative asset path. Returns null for URLs that don't match
 * the editor origin OR whose path doesn't end in a known asset
 * extension — those escape to the existing `openExternal` / default
 * navigation flow.
 *
 * Exported for test coverage of the matching logic without mounting
 * the safety net.
 */
export function matchAssetUrl(url: string, editorOrigin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const origin = parsed.origin;
  if (origin !== editorOrigin) return null;

  // Path starts with '/'. Strip leading slash to get the raw served
  // path — `/notes/meeting.pdf` → `notes/meeting.pdf`. The Vite dev
  // plugin and the production sirv middleware both serve project-
  // relative paths unchanged, so this matches the same filesystem
  // layout openAssetSafely's containment checks against.
  //
  // `URL.pathname` is percent-encoded per WHATWG URL — a file named
  // `my photo.png` shows up as `my%20photo.png`. `openAssetSafely`
  // calls `realpathSync` on the raw string, which would look for a
  // literal `my%20photo.png` on disk and fail with ENOENT. Decode
  // before forwarding so files with spaces / Unicode / other escaped
  // characters resolve correctly. Containment (`isPathWithinProject`
  // in `asset-allowlist.ts`) catches any `..` traversal that decoding
  // re-introduces, so this does not widen the safety boundary.
  const raw = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding (e.g. `%E0%A4` truncated, `%ZZ`).
    // Refuse — a click that produces an undecodable URL has no
    // realistic legitimate origin.
    return null;
  }
  if (!path) return null;

  // Only claim asset-extension paths. The app bundle (`/index.html`,
  // `/@vite/client`, `/@react-refresh`) stays on the default route so
  // Vite HMR + app reloads keep working.
  const lastSegment = path.split('/').pop() ?? '';
  const extMatch = lastSegment.match(/\.([a-z0-9]+)$/i);
  if (!extMatch) return null;
  const ext = (extMatch[1] ?? '').toLowerCase();
  // `html`/`htm` are ASSET_EXTENSIONS members (so their links resolve + serve
  // sandboxed) but the safety net must NOT claim them: the app bundle is served
  // as `/index.html`, so claiming it would route every app reload / Vite HMR
  // full-reload through `openAsset` (which refuses html) and break the editor.
  // Content-html clicks are routed by the renderer asset dispatcher (desktop:
  // reveal-in-Finder; web: window.open → openExternal), not this matcher.
  if (ext === 'html' || ext === 'htm') return null;
  if (!ASSET_EXTENSIONS.has(ext)) return null;

  return path;
}

/**
 * Origin of `url`, or null if absent/unparseable. Used to read the renderer's
 * own origin from `webContents.getURL()`.
 */
function safeOrigin(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * When `url` is an in-app SPA route served by the editor's OWN renderer —
 * a same-(renderer-)origin URL whose route lives in the hash (`#/…`) — return
 * the hash to navigate to; otherwise null. These reach `setWindowOpenHandler`
 * via the renderer's "open in new tab" gesture (`openHashHrefInNewTab` →
 * `window.open('#/doc', '_blank')` in `internal-link-helpers.ts`).
 *
 * The renderer origin is deliberately NOT `editorOrigin`: in dev the renderer
 * is served from `rendererDevUrl` (e.g. http://localhost:5173) while
 * `editorOrigin` is the separate utility/API port. So an in-app route's origin
 * matches the asset origin in neither dev nor an external host — it matches the
 * renderer's live origin (`webContents.getURL()`). Recognizing it is what keeps
 * these in-app instead of letting the `openExternal` fall-through hand a real
 * `http://localhost:5173/#/doc` URL to the OS browser (dev only — prod's
 * `file://` renderer origin is refused by `openExternal`).
 */
export function matchInAppRoute(url: string, rendererOrigin: string | null): string | null {
  if (!rendererOrigin) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== rendererOrigin) return null;
  // SPA routes live in the hash. A same-origin non-hash URL (the bundle entry,
  // or an asset already claimed above) is not a doc navigation.
  return parsed.hash.startsWith('#/') ? parsed.hash : null;
}

/**
 * JS that drives the SPA router by assigning the URL hash on the current
 * window. `hash` is already validated as a same-renderer-origin `#/…` route;
 * `JSON.stringify` guards the interpolation. Mirrors the URL-scheme `screen`
 * handler's renderer-hash navigation.
 */
function navigateToHashScript(hash: string): string {
  return `window.location.hash = ${JSON.stringify(hash)};`;
}

export function attachAssetSafetyNet(
  webContents: WebContentsLike,
  deps: AttachAssetSafetyNetDeps,
): void {
  const log = deps.log ?? DEFAULT_LOG;

  webContents.setWindowOpenHandler((details) => {
    const relPath = matchAssetUrl(details.url, deps.editorOrigin);
    if (relPath !== null) {
      // Fire-and-forget — the new-window request must be denied
      // synchronously via return value; the openAssetSafely call
      // continues in the background and logs on failure.
      void deps.openAsset(relPath).then((result) => {
        if (!result.ok) {
          log({
            level: 'warn',
            message: 'openAsset refused from setWindowOpenHandler',
            data: { relPath, reason: result.reason },
          });
        }
      });
      return { action: 'deny' };
    }
    // Same-renderer-origin in-app route (the "open in new tab" gesture on an
    // internal link). The desktop shell is a single window — there is no
    // OS-level new tab — so navigate the current window to the route instead of
    // handing it to the OS browser. Without this, in dev the route is a real
    // `http://localhost:5173/#/doc` URL and the `openExternal` fall-through
    // below opens it in the user's default browser (dev only — prod's `file://`
    // origin is refused by openExternal), flooding tabs as links are followed.
    const inAppHash = matchInAppRoute(details.url, safeOrigin(webContents.getURL?.()));
    if (inAppHash !== null) {
      const nav = webContents.executeJavaScript?.(navigateToHashScript(inAppHash));
      if (nav) {
        void nav.catch((err: unknown) => {
          log({
            level: 'warn',
            message: 'in-app navigation failed from setWindowOpenHandler',
            data: { hash: inAppHash, err: (err as Error).message },
          });
        });
      }
      return { action: 'deny' };
    }
    // Non-asset new-window request — delegate to the OS default browser
    // via the shared `handleShellOpenExternal` allowlist. Renderer paths
    // that already routed through `ok:shell:open-external` (HelpPopover,
    // AuthModal, install dialog) won't reach here because they
    // preventDefault first. The escape paths that DO reach here are:
    //   - markdown link PropPanel "Open in new tab" → `window.open(url)`
    //   - drop-time `<a target="_blank">` on transient embed nodes
    //   - pasted raw `<a href>` from another app's clipboard
    //   - any future renderer surface that forgets to use the bridge
    // openExternal throws on disallowed schemes (javascript:, data:,
    // file:, ms-msdt:, etc.) — caller logs and the click is dropped.
    void deps.openExternal(details.url).catch((err: unknown) => {
      log({
        level: 'warn',
        message: 'openExternal refused from setWindowOpenHandler',
        data: { url: details.url, err: (err as Error).message },
      });
    });
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    const relPath = matchAssetUrl(url, deps.editorOrigin);
    if (relPath !== null) {
      event.preventDefault();
      void deps.openAsset(relPath).then((result) => {
        if (!result.ok) {
          log({
            level: 'warn',
            message: 'openAsset refused from will-navigate',
            data: { relPath, reason: result.reason },
          });
        }
      });
      return;
    }
    // Same-origin navigation (Vite HMR full-reload, an in-app link that
    // somehow turned into a top-level navigate, the editor itself
    // reloading) — leave Electron's default handling alone.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    // In-app navigations stay in-app: the asset/API origin (`editorOrigin`) AND
    // the renderer's own origin (distinct from `editorOrigin` in dev — see
    // `matchInAppRoute`). Leaving Electron's default handling keeps a same-page
    // navigation in-app rather than leaking a `localhost:5173/#/doc` URL to the
    // OS browser via the `openExternal` fall-through below.
    if (
      parsed.origin === deps.editorOrigin ||
      parsed.origin === safeOrigin(webContents.getURL?.())
    ) {
      return;
    }
    // Cross-origin navigation that would otherwise replace the editor's
    // webContents with the destination page (pasted-href case).
    // preventDefault keeps the editor on screen; openExternal hands the
    // URL to the OS so the user actually reaches it.
    event.preventDefault();
    void deps.openExternal(url).catch((err: unknown) => {
      log({
        level: 'warn',
        message: 'openExternal refused from will-navigate',
        data: { url, err: (err as Error).message },
      });
    });
  });
}
