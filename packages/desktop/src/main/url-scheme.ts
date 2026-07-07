/**
 * `openknowledge://` deep-link URL scheme — parser + runtime handler.
 *
 * Public surfaces in this module:
 *   - Pure parsers — `parseOpenKnowledgeUrl` (`open` host, document deep
 *     links), `parseShareUrl` (`share` host + `openknowledge.ai` universal
 *     links), `parseScreenUrl` (`screen` host, named-screen deep links). No
 *     Electron import at module top, so unit tests exercise them without a real
 *     Electron runtime (precedent #4 — shared computation, per-surface render).
 *   - `registerProtocolHandler(deps)` — wires `app.on('open-url', ...)` +
 *     `app.on('second-instance', ...)`, scans `process.argv` for cold-start
 *     CLI-launch delivery, and implements the VS Code queue-then-flush
 *     pattern so macOS cold-start Apple Events that fire before `whenReady`
 *     are never lost.
 *
 * **Caller contract:** `app.requestSingleInstanceLock()` MUST be acquired by
 * the caller BEFORE `registerProtocolHandler` runs. Without the lock, the
 * `second-instance` event cannot fire (Electron only dispatches it on the
 * primary when a secondary invocation relinquishes the lock), so the
 * documented "CLI launch with argv delivery" path is silently dead. The
 * current call site is `packages/desktop/src/main/index.ts`, gated on
 * `GOT_SINGLE_INSTANCE_LOCK`.
 *
 * Validation layers (URL shape: `openknowledge://open?project=<abs>&doc=<name>`):
 *   1. Reject null bytes anywhere in the raw input (`\x00`, `%00`).
 *   2. Protocol must be `openknowledge:`; host must be `open`.
 *   3. `project` + `doc` required; each URL-decoded before path checks.
 *   4. `project` must be absolute AND must not contain `..` segments after
 *      `path.normalize()` — `path.resolve` would silently flatten `../../etc/x`
 *      to `/etc/x`, so we reject ANY `..` segment in the decoded path.
 *   5. `doc` must be a relative in-project name — reject any `..` segment (so
 *      `a/../b`, `../a`, and `..` all fail) and reject Windows `\` separators.
 *      `/` IS allowed as a segment separator — nested docNames like
 *      `notes/meeting-2026` are the common MCP producer shape (see
 *      `packages/cli/src/mcp/tools/write-document.ts:31` + `preview-url.ts:183`),
 *      and the renderer round-trips them cleanly via `encodeURIComponent(doc)`
 *      + `docNameFromHash` (`packages/app/src/lib/doc-hash.ts:14`).
 *
 * URL shape is fixed by an upstream contract; this module is downstream of it —
 * changes must be made there, not here.
 */

import { isAbsolute, resolve } from 'node:path';
import { parseGitHubShareUrl } from '@inkeep/open-knowledge';
import {
  type CandidateSelection,
  decodeShareUrl,
  InvalidShareUrlError,
  UnsupportedShareVersionError,
} from '@inkeep/open-knowledge-core';
import type {
  OkSharePayloadFields,
  OkShareReceivedPayload,
  ShareTarget,
} from '../shared/bridge-contract.ts';
import type { CheckTargetExistsResult } from './check-target-exists.ts';

/**
 * Collapse a kind-discriminated `ShareTarget` to its bare repo-relative path.
 * A `doc` target carries the file path on `docPath`; a `folder` target carries
 * the directory path on `folderPath` (empty string for the content-dir root).
 */
function shareTargetPath(target: ShareTarget): string {
  return target.kind === 'doc' ? target.docPath : target.folderPath;
}

/**
 * Successful parse result — host is narrowed to the one supported value.
 * `kind` discriminates a doc deep-link (`doc=`) from a folder deep-link
 * (`folder=`). `doc` carries the target path for BOTH kinds (named `doc` for
 * back-compat with the `ok:deep-link` payload convention, whose `doc` field is
 * the target path regardless of kind — the renderer's `encodeShareTargetForHash`
 * branches on `kind`). Skills need no kind here: they ride `doc=__skill__/…`
 * and resolve as ordinary editor tabs via `docNameFromHash`.
 */
interface ParsedOpenKnowledgeUrl {
  readonly host: 'open';
  readonly project: string;
  readonly kind: 'doc' | 'folder';
  readonly doc: string;
}

/**
 * Universal-link host(s) we recognize for the share flow. Apple's AASA file
 * lists both apex + www from the first shipped version — the decoder must accept
 * both or AASA-routed clicks from one host silently drop.
 */
const SHARE_UNIVERSAL_LINK_HOSTS = new Set(['openknowledge.ai', 'www.openknowledge.ai']);

/** Universal-link path prefix that carries the v1 base64url-encoded payload. */
const SHARE_UNIVERSAL_LINK_PATH_PREFIX = '/d/';

/**
 * Extract `webpageURL` from either `ContinueActivityDetails` (modern Electron)
 * or `NSUserActivity.userInfo` (legacy shape + the story AC's text). Returns
 * `null` on any non-string field or absent source. The continue-activity
 * handler tries `details` first, then falls back to `userInfo`.
 */
function readWebpageURL(source: unknown): string | null {
  if (source === null || typeof source !== 'object') return null;
  const candidate = (source as { webpageURL?: unknown }).webpageURL;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/** Successful share-URL parse — the routing payload the receive dialog renders
 *  against. Aliases the canonical kind-aware `OkSharePayloadFields` (carries
 *  `target: ShareTarget` + `sharedUrl`) so the parse output and the IPC payload
 *  can't drift, matching the `ShareDeepLinkFields` alias. */
export type ShareUrlPayload = OkSharePayloadFields;

/**
 * Tagged source-of-input so the [receive] structured log can distinguish
 * Slack/iMessage-unfurled clicks (`universal-link`) from the splash page's
 * "Open in OpenKnowledge" button (`custom-scheme`). Renderer doesn't need
 * this — it's main-process diagnostics only.
 */
export type ShareUrlSource = 'universal-link' | 'custom-scheme';

/**
 * Discriminated parse result for a share URL. Three terminal kinds:
 *   - `ok` — caller dispatches the receive dialog
 *   - `unsupported-version` — caller surfaces an "Update OpenKnowledge" toast
 *   - `invalid` — caller surfaces an "Invalid share URL" toast
 *
 * `parseShareUrl` returns `null` (the discriminant-free signal) ONLY when the
 * URL is neither a recognized universal-link nor an `openknowledge://share`
 * URL — the caller MUST then fall through to `parseOpenKnowledgeUrl` for the
 * legacy `open` action.
 */
export type ShareParseResult =
  | { readonly kind: 'ok'; readonly source: ShareUrlSource; readonly payload: ShareUrlPayload }
  | {
      readonly kind: 'unsupported-version';
      readonly source: ShareUrlSource;
      readonly version: number;
    }
  | { readonly kind: 'invalid'; readonly source: ShareUrlSource };

/**
 * Common share fields carried on every `ShareDeepLinkPayload` variant that
 * successfully decoded. Aliases the canonical `OkSharePayloadFields` from
 * `../shared/bridge-contract` (same package) so the routing payload and the
 * renderer IPC contract cannot silently drift on these fields.
 */
export type ShareDeepLinkFields = OkSharePayloadFields;

/**
 * Branch-switch payload delivered when the share resolves to an existing OK
 * project on a different branch. Carries the share fields + the resolved
 * project path + the current HEAD branch (so the renderer's branch-switch
 * surface can label the prompt correctly without re-reading HEAD).
 */
export interface ShareDeepLinkBranchSwitchPayload {
  readonly share: ShareDeepLinkFields;
  readonly projectPath: string;
  readonly currentBranch: string | null;
}

/**
 * Renderer-facing IPC payload for `ok:share:received`. Aliases the canonical
 * `OkShareReceivedPayload` from `../shared/bridge-contract` (same package)
 * so the routing payload and the renderer IPC contract cannot drift — the
 * `ShareNavigatorPayload` `Extract` derivation still works on the alias.
 *
 * Present-on-shared-branch (the `branch-match-ok` outcome) is delivered via
 * the existing `ok:deep-link` channel, not `ok:share:received` — no panel
 * needed.
 */
export type ShareDeepLinkPayload = OkShareReceivedPayload;

/** Launcher-scoped subset of `ShareDeepLinkPayload` — the two kinds the
 *  Navigator hosts. Derived (not hand-copied) from `ShareDeepLinkPayload` so it
 *  stays in lockstep with the source variants; passed to `routeShareToNavigator`
 *  so the routing decision stays exhaustive at compile time. */
export type ShareNavigatorPayload = Extract<
  ShareDeepLinkPayload,
  { readonly kind: 'launcher-consent' } | { readonly kind: 'launcher-miss' }
>;

/**
 * Parse + validate a share URL. Handles both shapes:
 *   - Universal link: `https://openknowledge.ai/d/<base64url([0x01]||blob-url)>`
 *     (and `www.openknowledge.ai`) — base64url-decode, version-byte dispatch,
 *     blob-URL shape check. Tolerates unknown query params and fragments for
 *     forward-compatible payload extensibility.
 *   - Custom scheme: `openknowledge://share?url=<urlencoded(<blob-url>)>` —
 *     URL-decode the `url` param directly (no version byte; the custom-scheme
 *     path is the immediate-handoff path, never persisted to marketing copy).
 *
 * Returns `null` if the input is neither shape — caller falls through to
 * `parseOpenKnowledgeUrl` for the legacy `open` action.
 *
 * Never throws.
 */
export function parseShareUrl(input: string): ShareParseResult | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  // Null-byte defense mirrors `parseOpenKnowledgeUrl`. Reject before `new URL`
  // because `decodeURIComponent('%00')` produces `'\x00'`, which can truncate
  // paths in downstream C libraries.
  if (input.includes('\x00') || /%00/i.test(input)) return null;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol === 'openknowledge:' && url.hostname === 'share') {
    return parseShareCustomScheme(url);
  }
  if (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    SHARE_UNIVERSAL_LINK_HOSTS.has(url.hostname) &&
    url.pathname.startsWith(SHARE_UNIVERSAL_LINK_PATH_PREFIX)
  ) {
    return parseShareUniversalLink(url);
  }
  return null;
}

function parseShareUniversalLink(url: URL): ShareParseResult {
  // Path shape: `/d/<encoded>` plus optional trailing slashes / extra
  // segments. Reject extra segments (`/d/<encoded>/extra`) — splitting on
  // `/` and taking position 2 keeps us strict against accidental
  // path-prefix evolution (e.g. `/d/x/foo` would otherwise silently route
  // to `<encoded>=x`). Query params + fragments stay tolerated.
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length !== 2 || segments[0] !== 'd') {
    return { kind: 'invalid', source: 'universal-link' };
  }
  const encoded = segments[1];
  if (encoded === undefined || encoded.length === 0) {
    return { kind: 'invalid', source: 'universal-link' };
  }
  let decoded: { sharedUrl: string };
  try {
    decoded = decodeShareUrl(encoded);
  } catch (err) {
    if (err instanceof UnsupportedShareVersionError) {
      return {
        kind: 'unsupported-version',
        source: 'universal-link',
        version: err.version,
      };
    }
    if (err instanceof InvalidShareUrlError) {
      return { kind: 'invalid', source: 'universal-link' };
    }
    // Any other thrown shape is also invalid — never let decoder errors
    // escape to the routing layer.
    return { kind: 'invalid', source: 'universal-link' };
  }
  return finalizeShareResult(decoded.sharedUrl, 'universal-link');
}

function parseShareCustomScheme(url: URL): ShareParseResult {
  // The custom-scheme path carries the URL directly without the
  // version byte. The custom scheme is the immediate-handoff path (splash
  // page → OK) and never appears in marketing copy, so version-dispatch
  // would only add complexity for no benefit.
  const rawSharedUrl = url.searchParams.get('url');
  if (!rawSharedUrl) {
    return { kind: 'invalid', source: 'custom-scheme' };
  }
  // URLSearchParams.get already URL-decodes; no further decode needed.
  return finalizeShareResult(rawSharedUrl, 'custom-scheme');
}

/**
 * Upper bound on the decoded blob URL we'll route. Real GitHub blob URLs
 * comfortably fit in a few hundred bytes; a multi-MB string from a hostile
 * deep link should short-circuit before we exercise the URL parser.
 */
const MAX_SHARED_URL_LENGTH = 4096;

function finalizeShareResult(sharedUrl: string, source: ShareUrlSource): ShareParseResult {
  if (typeof sharedUrl !== 'string' || sharedUrl.length === 0) {
    return { kind: 'invalid', source };
  }
  if (sharedUrl.length > MAX_SHARED_URL_LENGTH) {
    return { kind: 'invalid', source };
  }
  // Post-decode null-byte recheck — defense-in-depth against payloads that
  // smuggle a null byte through layered encodings.
  if (sharedUrl.includes('\x00')) {
    return { kind: 'invalid', source };
  }
  const parsed = parseGitHubShareUrl(sharedUrl);
  if (parsed === null) {
    return { kind: 'invalid', source };
  }
  // A blob URL parses to `kind: 'doc'` (the file path); a tree URL parses to
  // `kind: 'folder'` (the directory path, possibly empty for the repo root).
  const target: ShareTarget =
    parsed.kind === 'doc'
      ? { kind: 'doc', docPath: parsed.path }
      : { kind: 'folder', folderPath: parsed.path };
  return {
    kind: 'ok',
    source,
    payload: {
      owner: parsed.owner,
      repo: parsed.repo,
      branch: parsed.branch,
      sharedUrl,
      target,
    },
  };
}

/**
 * Parse + validate an `openknowledge://...` URL. Returns `null` on any
 * validation failure (unknown protocol, unknown host, missing params, path
 * traversal, null bytes, ...). Never throws.
 */
export function parseOpenKnowledgeUrl(input: string): ParsedOpenKnowledgeUrl | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  // Reject null bytes BEFORE URL parsing. `new URL()` happily keeps `%00`
  // around, and `decodeURIComponent('%00')` produces `'\x00'` which can
  // truncate paths in downstream C libraries.
  if (input.includes('\x00') || /%00/i.test(input)) return null;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'openknowledge:') return null;
  if (parsed.hostname !== 'open') return null;

  const rawProject = parsed.searchParams.get('project');
  const rawDoc = parsed.searchParams.get('doc');
  const rawFolder = parsed.searchParams.get('folder');
  if (!rawProject) return null;
  // Exactly one of `doc` / `folder`. Both present (ambiguous) or neither
  // (nothing to open) → reject. `==` to catch both null and undefined.
  if ((rawDoc == null) === (rawFolder == null)) return null;
  const kind: 'doc' | 'folder' = rawDoc != null ? 'doc' : 'folder';
  const rawTarget = (rawDoc ?? rawFolder) as string;

  let project: string;
  let doc: string;
  try {
    project = decodeURIComponent(rawProject);
    doc = decodeURIComponent(rawTarget);
  } catch {
    return null;
  }

  // Post-decode null-byte recheck — defense in depth against smugglers that
  // layer encodings (e.g. `%2500` → `%00` → `\x00`).
  if (project.includes('\x00') || doc.includes('\x00')) return null;

  if (project.length === 0 || doc.length === 0) return null;

  if (!isAbsolute(project)) return null;
  // Check for `..` segments in the decoded-but-unnormalized path. `path.resolve`
  // and `path.normalize` BOTH silently flatten `/foo/../../etc/passwd` into
  // `/etc/passwd`, so either would sneak a traversal past the check. The only
  // safe gate is "does the raw string split on separators contain `..`."
  if (project.split(/[/\\]/).includes('..')) return null;

  // `doc` (doc name OR folder path) is a relative in-project name. Nested paths
  // (`notes/meeting`, `specs/foo`) ARE allowed; skills ride this as the synthetic
  // `__skill__/<scope>/<name>` docName. Reject `..` segments (any position),
  // Windows-style `\` separators, and leading `/` (which would be interpreted as
  // an absolute path in unrelated downstream code). Same rules for both kinds.
  if (doc.includes('\\')) return null;
  if (doc.startsWith('/')) return null;
  if (doc.split('/').includes('..')) return null;

  return {
    host: 'open',
    project: resolve(project),
    kind,
    doc,
  };
}

/** Parsed `openknowledge://open?file=<abs>` — the single-file open deep-link. */
interface ParsedOpenKnowledgeFileUrl {
  readonly host: 'open';
  /** Absolute, resolved path of the file to open. */
  readonly file: string;
}

/**
 * Parse + validate the single-file-open deep-link
 * `openknowledge://open?file=<abs>` (the desktop side of `ok <file>`). Distinct
 * from `parseOpenKnowledgeUrl` (`project=&doc=`) by the `file` param — both use
 * the `open` host, so `routeUrl` tries this parser first and falls through to
 * the project-doc parser when `file` is absent. Returns `null` on any validation
 * failure (missing param, null bytes, relative path, `..` traversal); never
 * throws. The receiver (`openEphemeralFile`) re-derives the project-vs-ephemeral
 * decision via `prepareSingleFileOpen`, so this only enforces the URL shape.
 */
export function parseOpenKnowledgeFileUrl(input: string): ParsedOpenKnowledgeFileUrl | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  // Null-byte defense mirrors `parseOpenKnowledgeUrl`.
  if (input.includes('\x00') || /%00/i.test(input)) return null;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'openknowledge:') return null;
  if (parsed.hostname !== 'open') return null;

  const rawFile = parsed.searchParams.get('file');
  if (!rawFile) return null;

  let file: string;
  try {
    file = decodeURIComponent(rawFile);
  } catch {
    return null;
  }

  // Post-decode null-byte recheck — defense in depth against layered encodings.
  if (file.includes('\x00')) return null;
  if (file.length === 0) return null;

  // The CLI emits an absolute realpath; reject relative + `..`-bearing paths
  // (same rationale as the `project` checks above — `path.resolve`/`normalize`
  // would silently flatten a traversal, so gate on the raw split).
  if (!isAbsolute(file)) return null;
  if (file.split(/[/\\]/).includes('..')) return null;

  return { host: 'open', file: resolve(file) };
}

/**
 * Named app screens reachable via `openknowledge://screen?name=<id>`. Each maps
 * to a renderer URL-hash route (`window.location.hash`, handled in `App.tsx`)
 * for a surface with a stable address — today Settings and the Install-in-Claude
 * dialog, the same two hashes the app menu drives. Document opens use
 * `openknowledge://open` (see `parseOpenKnowledgeUrl`); most other UI is
 * conditional runtime state (toasts, error views, action-triggered dialogs)
 * with no addressable route. Extend this allowlist as the renderer gains hashes.
 */
const SCREEN_TARGETS = ['settings', 'install-claude'] as const;
export type ScreenTarget = (typeof SCREEN_TARGETS)[number];

interface ParsedScreenUrl {
  readonly host: 'screen';
  readonly name: ScreenTarget;
}

function isScreenTarget(value: string): value is ScreenTarget {
  return (SCREEN_TARGETS as readonly string[]).includes(value);
}

/**
 * Parse + validate an `openknowledge://screen?name=<id>` URL. Returns `null` on
 * any failure (wrong protocol/host, missing or unknown `name`, null bytes).
 * Never throws. `name` is matched against the fixed `SCREEN_TARGETS` allowlist,
 * so there are no path/filesystem semantics to defend — but the null-byte guard
 * is kept for parity with the sibling scheme parsers.
 */
export function parseScreenUrl(input: string): ParsedScreenUrl | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  if (input.includes('\x00') || /%00/i.test(input)) return null;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'openknowledge:') return null;
  if (parsed.hostname !== 'screen') return null;

  const rawName = parsed.searchParams.get('name');
  if (!rawName) return null;

  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return null;
  }
  if (!isScreenTarget(name)) return null;

  return { host: 'screen', name };
}

/**
 * Side-effect surface for `registerProtocolHandler`. Injected so the main-
 * process glue can pass real `openProject` / `focusWindowForProject` / `send`
 * functions while tests pass stubs.
 */
interface ProtocolHandlerDeps {
  /** `electron.app` subset — the listeners + setters we touch. */
  app: {
    on(event: 'open-url', cb: (event: { preventDefault: () => void }, url: string) => void): void;
    on(event: 'second-instance', cb: (event: unknown, argv: readonly string[]) => void): void;
    on(event: 'before-quit', cb: () => void): void;
    // macOS Handoff / Universal Links: `details.webpageURL` carries the
    // tapped-link URL when the receiver is OK. Fires only on darwin per
    // Electron's `@platform darwin` annotation; harmless no-op on other
    // platforms because the event never emits. Per the modern Electron API
    // the URL lives on `details`, not `userInfo` — the handler accepts both
    // shapes defensively, but the type here mirrors Electron's contract.
    on(
      event: 'continue-activity',
      cb: (
        event: { preventDefault: () => void },
        type: string,
        userInfo: unknown,
        details?: { webpageURL?: string },
      ) => void,
    ): void;
    whenReady(): Promise<void>;
    isPackaged: boolean;
    setAsDefaultProtocolClient(scheme: string): boolean;
    /**
     * Remove the runtime Launch Services binding for this scheme. Called in
     * dev mode on `before-quit` to avoid "openknowledge:// sometimes opens
     * the wrong build" when developers switch worktrees — without this,
     * Launch Services routes subsequent `open openknowledge://...` calls
     * to the last-registered binary path until another app claims the
     * scheme.
     */
    removeAsDefaultProtocolClient(scheme: string): boolean;
  };
  /** Resolve an existing BrowserWindow for a project path, or null. */
  focusWindowForProject(projectPath: string): BrowserWindowHandle | null;
  /**
   * Spawn a new window for a project path. Returns `null` when the spawn
   * failed AND the error has already been surfaced to the user (dialog,
   * Navigator fallback) — the caller need not dispatch anything downstream.
   *
   * `pendingDeepLinkTarget` threads the deep-link payload through so the
   * implementation registers `webContents.once('dom-ready', ...)` BEFORE
   * `loadURL` awaits — the event must land after the renderer's subscriber
   * mounts but before `did-finish-load` (which fires after dom-ready). See
   * `window-manager.ts:createProjectWindow` for the wiring.
   */
  openProject(
    projectPath: string,
    opts?: {
      pendingDeepLinkTarget?: { kind: 'doc' | 'folder'; path: string };
      pendingBranch?: string | null;
      /**
       * Multi-candidate hint forwarded into `ok:deep-link` so the
       * renderer's "Opened on branch X" toast only fires when the
       * dispatch had >1 candidate (multi-worktree receivers). Threads
       * through `createProjectWindow` -> `pendingMultiCandidate` ->
       * the dom-ready gate registered before `loadURL`.
       */
      pendingMultiCandidate?: boolean;
      /**
       * Stale-branch hint forwarded into `ok:deep-link` so the dispatched
       * window toasts "not on this branch yet" instead of silently opening a
       * blank editor when the share's target isn't on the checked-out branch.
       * Threads through `createProjectWindow` -> the dom-ready gate.
       */
      pendingTargetMissing?: boolean;
      /**
       * Project-scoped branch-switch payload to deliver on the editor's
       * `dom-ready` after `createProjectWindow` resolves. When provided,
       * `pendingDeepLinkTarget` is typically absent — the branch-switch
       * surface handles navigation after the user confirms the switch.
       */
      pendingShareBranchSwitch?: ShareDeepLinkBranchSwitchPayload;
    },
  ): Promise<BrowserWindowHandle | null>;
  /**
   * Open a no-project file in an ephemeral single-file session (the
   * `openknowledge://open?file=` deep-link, desktop side of `ok <file>`). The
   * implementation re-derives the plan via `prepareSingleFileOpen` and
   * routes project-vs-ephemeral itself, so this dep just hands off the validated
   * absolute path. Optional — when omitted (tests not exercising single-file
   * open), `file=` URLs warn-log silent-drop. Production main always wires it.
   */
  openEphemeralFile?(filePath: string): Promise<void>;
  /** Typed event dispatch — pushes `ok:deep-link` with the doc/folder path + kind (and optional share branch + multi-candidate hint). Used only on the warm (focus-existing) path where the renderer subscriber has been mounted for the lifetime of the window. Cold-spawn delivery is handled inside `openProject` via dom-ready gating, not via this dep. The payload mirrors the cold gate's `ok:deep-link` shape (window-manager.ts) so warm and cold navigation are identical. */
  sendDeepLink(
    win: BrowserWindowHandle,
    payload: {
      doc: string;
      kind: 'doc' | 'folder';
      branch?: string | null;
      multiCandidate?: boolean;
      targetMissing?: boolean;
    },
  ): void;
  /**
   * Typed event dispatch — pushes `ok:share:received` with the discriminated
   * share payload. Caller delivers to the most-recently-focused window
   * Delivers a surface-specific payload (`project-branch-switch` to an
   * editor, or the error toasts) once `resolveShareTarget` has decided the
   * target. Renderer surfaces a sonner toast on the two error kinds
   * (`unsupported-version` / `invalid`).
   *
   * Optional — when omitted, share URLs route to a warn-log silent-drop.
   * Production main wires the real implementation in `main/index.ts`.
   */
  sendShareDeepLink?(win: BrowserWindowHandle, payload: ShareDeepLinkPayload): void;
  /**
   * Resolve a share's target by running the shared `selectCandidate`
   * algorithm against main-side git I/O. Production wires
   * `resolveShareTarget` from `./resolve-share-target.ts` (which
   * threads `appState.recentProjects` as the recents lister). Tests
   * stub this so the routing decision can be exercised without standing
   * up a real git repo.
   *
   * Optional — when omitted, share URLs warn-log silent-drop (resolution
   * is the decision authority; without it there is no target to route to).
   * Production main always wires it.
   */
  resolveShareTarget?(share: ShareUrlPayload): Promise<CandidateSelection>;
  /**
   * Kind-aware target-existence gate, run AFTER `resolveShareTarget` returns
   * `branch-match-ok` and BEFORE dispatch: probes `<projectPath>/<path>` for a
   * regular file (`doc`) or directory (`folder`). A `'missing'` result means
   * the share's target isn't on the receiver's currently checked-out branch
   * (stale-branch scenario) — the dispatched window toasts "not on this branch
   * yet" instead of silently opening a blank editor. Production wires the
   * native `checkTargetExists` from `./check-target-exists.ts`. Optional —
   * when omitted (or for content-root folder shares) the gate is skipped and
   * dispatch proceeds, matching the pre-gate behavior.
   */
  checkShareTargetExists?(
    projectPath: string,
    kind: 'doc' | 'folder',
    path: string,
  ): CheckTargetExistsResult;
  /**
   * Deliver a launcher-scoped share payload to the Navigator (opening it
   * first if necessary). Main wires this to `openNavigator` +
   * `webContents.send('ok:share:received', payload)`. Optional — when
   * omitted, launcher-scoped shares silent-drop with a warn.
   */
  routeShareToNavigator?(payload: ShareNavigatorPayload): void;
  /**
   * Open a named app screen (Settings, Install-in-Claude) in the given window
   * by navigating its renderer URL hash. Optional — when omitted, screen deep
   * links route to a warn-log silent-drop. Production main wires it to the same
   * hash trigger the app menu uses.
   */
  openScreen?(win: BrowserWindowHandle, screen: ScreenTarget): void;
  /**
   * Returns the most-recently-focused BrowserWindow, or `null` when no
   * window is focused (cold-launch path, every window minimized to dock).
   * The screen-route handler falls through to `getAnyReadyWindow` when this
   * returns null — both deps are wired in `main/index.ts`.
   *
   * Optional — production wires it.
   */
  getFocusedWindow?(): BrowserWindowHandle | null;
  /**
   * Returns any currently-ready BrowserWindow, or null if none. The flush loop
   * retries up to 10 × 500ms while this returns null — flushing URLs before
   * the first window is up would drop them into a void.
   */
  getAnyReadyWindow(): BrowserWindowHandle | null;
  /**
   * Initial `process.argv` snapshot for cold-start CLI-launch delivery. The
   * handler scans argv once at registration time for `openknowledge://`
   * entries; macOS packaged builds receive URLs via the `open-url` Apple
   * Event, but direct-binary launches (`OK.app/Contents/MacOS/OpenKnowledge
   * openknowledge://...`) and dev-mode electron-vite launches deliver via
   * argv. Defaults to `process.argv` when omitted; tests inject a stub.
   */
  getInitialArgv?: () => readonly string[];
  /** Test injection for `setTimeout`. Defaults to the global. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  /** Test injection for the dedup clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Optional structured logger. */
  log?: {
    warn(obj: object, msg: string): void;
    info?(obj: object, msg: string): void;
  };
}

/**
 * Opaque handle to a BrowserWindow — we pass it between deps without caring
 * about Electron internals. Shape-compatible with `BrowserWindowLike` from
 * `window-manager.ts` plus Electron's `BrowserWindow` at runtime.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentional — opaque handle.
interface BrowserWindowHandle {}

/**
 * Cold-start control surface returned to `main/index.ts`'s boot path. Lets the
 * boot decision suppress its default window when a single-file deep-link claimed
 * the launch, and drain the queue itself (the window-creating route opens the
 * file window directly — no boot-restore window for the auto-flush's
 * `getAnyReadyWindow()` gate to wait on).
 */
interface ProtocolHandlerControl {
  /**
   * `true` once a `openknowledge://open?file=` (`ok <file>`) URL has been seen
   * this run — cold-start queued OR routed. Distinct from `urlLaunchOwnsWindow`:
   * the single-file launch opens a git-OFF ephemeral server, so the boot path
   * also skips the git preflight for it. Share launches do NOT set this (they
   * open/clone a git-backed project and still need the preflight).
   */
  singleFileLaunch(): boolean;
  /**
   * `true` once a launch-claiming URL that opens its OWN window has been seen
   * this run (cold-start queued OR routed) — a single-file open (`ok <file>`)
   * OR a VALID share (`openknowledge.ai/d/...` / `openknowledge://share?url=...`
   * that parses to an `ok` target and dispatches to a project window or the
   * Navigator). The boot path reads it once, post-bootstrap, to suppress the
   * default boot-restore window so the URL flush owns the launch's initial
   * window — otherwise the previously-opened project opens instead of the
   * shared target. EXCLUDES inbound URLs that need a pre-existing window:
   * an invalid/unsupported share (its toast must land in a window) and a
   * `screen` deep-link (it navigates an existing window's hash).
   */
  urlLaunchOwnsWindow(): boolean;
  /**
   * Drain every queued URL now, bypassing the auto-flush's window-ready gate.
   * Called by the boot path when it suppresses the default window — there is no
   * boot-restore window to satisfy `getAnyReadyWindow()`, and the URL flush
   * (single-file open or valid share) creates its own window. Idempotent +
   * coordinates with the auto-flush via the shared `flushed` flag.
   */
  drainQueuedUrls(): void;
  /**
   * Route a URL through the same queue-then-flush + parse + resolve spine as an
   * inbound Apple Event. Used by the first-run deferred-share handshake to feed
   * a redeemed `https://openknowledge.ai/d/<token>` universal-link URL into the
   * existing validated receive path — no new trust, no parallel routing.
   * Subject to the same near-simultaneous-duplicate dedup as every other share.
   */
  routeUrl(url: string): void;
}

/**
 * Window within which the same share target (keyed on its canonical
 * `sharedUrl`) routes at most once. Defeats the double-delivery race where a
 * first-run loopback redemption and a simultaneous splash "Open in Open
 * Knowledge" re-click both deliver the same share.
 */
const SHARE_DEDUP_WINDOW_MS = 10_000;

const QUEUE_FLUSH_MAX_ATTEMPTS = 10;
const QUEUE_FLUSH_INTERVAL_MS = 500;

/**
 * Wire `open-url` + `second-instance` handlers synchronously. Call from the
 * main-process entry BEFORE `app.whenReady()` — on macOS the `open-url` Apple
 * Event can arrive before any `ready` lifecycle hook, and even before
 * `will-finish-launching` if the Launch Services binding races us.
 *
 * Safe to call multiple times per-process only if you reset state — tests
 * must spin a fresh handler module per run. Production calls this exactly
 * once at top of `main/index.ts`.
 */
export function registerProtocolHandler(deps: ProtocolHandlerDeps): ProtocolHandlerControl {
  const schedule = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const urlQueue: string[] = [];
  // Canonical-sharedUrl → last-routed timestamp, for SHARE_DEDUP_WINDOW_MS
  // near-simultaneous-duplicate suppression (deferred redemption vs splash
  // re-click). In-memory only; bounded by the share-arrival rate × window.
  const shareDedup = new Map<string, number>();
  let flushed = false;
  // Set once a single-file deep-link (`ok <file>`) is seen this run. The boot
  // path consults it post-bootstrap to suppress the default boot-restore window.
  // Never reset: the boot path reads it exactly once at startup, so a later warm
  // `ok <file>` setting it again is inert — there is no boot decision left to
  // influence. Sticky keeps the read race-free regardless of whether the URL was
  // queued (cold) or routed immediately (the early-flush path).
  let singleFileLaunch = false;
  // Set once a launch-claiming URL that opens its OWN window is seen this run —
  // a single-file open OR a valid (`ok`) share. The boot path reads it once to
  // suppress the default boot-restore window so the URL flush owns the launch.
  // Superset of `singleFileLaunch`; same sticky/never-reset rationale.
  let urlLaunchOwnsWindow = false;

  // Dev-mode registration — unpackaged Electron's Info.plist belongs to the
  // Electron.app shell, not this app, so Launch Services has no binding.
  // `setAsDefaultProtocolClient` writes a runtime binding so `open
  // openknowledge://...` targets the dev instance during development. Packaged
  // builds rely on `CFBundleURLTypes` from electron-builder.yml.
  if (!deps.app.isPackaged) {
    try {
      // Per Electron docs `setAsDefaultProtocolClient` is non-throwing and
      // returns `false` when the OS refused the binding (another app owns
      // the scheme, sandboxing, permissions). Surface `false` as a warn —
      // without it the only symptom is "dev deep-links silently reach the
      // wrong instance," which burns hours to diagnose.
      const ok = deps.app.setAsDefaultProtocolClient('openknowledge');
      if (!ok) {
        deps.log?.warn(
          {},
          '[url-scheme] setAsDefaultProtocolClient returned false — dev deep-links may not reach this instance',
        );
      } else {
        // Unregister on dev-exit so a stale Launch Services binding doesn't
        // route subsequent `open openknowledge://...` to a moved/deleted
        // worktree — a developer-UX footgun when switching between checkouts.
        // Hard exits (SIGKILL) skip `before-quit`, so the guarantee is
        // best-effort: the next successful dev-exit re-registers cleanly.
        // Packaged builds skip this entirely — their `CFBundleURLTypes`
        // binding is installed by the OS at DMG install time and owned by
        // Launch Services, not by us.
        deps.app.on('before-quit', () => {
          try {
            deps.app.removeAsDefaultProtocolClient('openknowledge');
          } catch (err) {
            deps.log?.warn(
              { err: (err as Error).message },
              '[url-scheme] removeAsDefaultProtocolClient failed on before-quit',
            );
          }
        });
      }
    } catch (err) {
      deps.log?.warn(
        { err: (err as Error).message },
        '[url-scheme] setAsDefaultProtocolClient failed',
      );
    }
  }

  /**
   * Send a non-ok (toast-only) share payload to the focused/any window. Used
   * for the `unsupported-version` and `invalid` parse outcomes — the
   * renderer surfaces these as sonner toasts, no resolution required.
   */
  const broadcastShareToast = (
    url: string,
    payload: { readonly kind: 'unsupported-version' } | { readonly kind: 'invalid' },
  ): void => {
    const sendShare = deps.sendShareDeepLink;
    if (!sendShare) {
      deps.log?.warn({ url }, '[receive] sendShareDeepLink dep missing — share dropped');
      return;
    }
    const target = deps.getFocusedWindow?.() ?? deps.getAnyReadyWindow();
    if (!target) {
      deps.log?.warn({ url }, '[receive] no target window — share dropped');
      return;
    }
    sendShare(target, payload);
  };

  /**
   * Dispatch a resolved share outcome to the correct surface:
   *   - `branch-match-ok` — open or focus the project's editor; thread the
   *     doc through the existing `ok:deep-link` channel. No panel.
   *   - `fallback` (OK-initialized, different branch) — open or focus the
   *     editor; deliver the `project-branch-switch` payload to the editor
   *     shell, which hosts the branch-switch surface.
   *   - `branch-match-non-ok` — open or focus the Navigator; deliver the
   *     `launcher-consent` payload.
   *   - `miss` — open or focus the Navigator; deliver the `launcher-miss`
   *     payload.
   *
   * Warm-vs-cold delivery for the project-branch-switch case: if the
   * project's editor is already open AND a sender is wired, focus + send
   * directly. Otherwise spawn the editor with `pendingShareBranchSwitch`
   * threaded so window-manager's dom-ready hook delivers after mount.
   */
  const dispatchResolvedShare = (
    url: string,
    share: ShareUrlPayload,
    selection: CandidateSelection,
  ): void => {
    deps.log?.info?.({ url, selection: selection.kind }, '[receive] action=routed');
    // Degrade-to-Navigator for the openProject null/reject paths below. Mirrors
    // the explicit dep-check the direct-dispatch cases use (branch-match-non-ok
    // / miss): when `routeShareToNavigator` is unwired the degrade is logged,
    // not silently swallowed by optional chaining — production always wires it,
    // but the log asymmetry would otherwise mislead debugging.
    const degradeToLauncherMiss = (logCtx: Record<string, unknown>, message: string): void => {
      deps.log?.warn(logCtx, message);
      if (!deps.routeShareToNavigator) {
        deps.log?.warn(
          logCtx,
          '[receive] routeShareToNavigator dep missing — launcher-miss degrade dropped',
        );
        return;
      }
      deps.routeShareToNavigator({ kind: 'launcher-miss', share });
    };
    switch (selection.kind) {
      case 'branch-match-ok': {
        // Project-scoped target navigate. Warm path: the project's editor is
        // already open, so its `ok:deep-link` subscriber has been mounted for
        // the window's lifetime — focus it and deliver immediately. Cold path:
        // spawn via openProject so window-manager's dom-ready gate delivers
        // once the renderer mounts. (createProjectWindow focuses an existing
        // window with an early return BEFORE its pendingDeepLinkTarget gate, so
        // relying on openProject alone drops the nav on the warm case.) No panel.
        const targetPath = shareTargetPath(share.target);
        // Kind-aware target-existence gate: confirm the share's target exists
        // on the candidate's checked-out branch before dispatch. A stale branch
        // (target added on the remote but not yet fetched) would otherwise open
        // a blank editor / empty folder with no signal. Content-root folder
        // shares (empty path) always exist (the working tree) — skip the probe.
        // A `'missing'` result still dispatches into the correct project window
        // (no launcher flash) but flags `targetMissing` so the renderer toasts
        // "not on this branch yet" in-context. `'unreadable'` graceful-fails to
        // a normal dispatch.
        const isContentRoot = share.target.kind === 'folder' && targetPath === '';
        const targetMissing =
          !isContentRoot &&
          deps.checkShareTargetExists?.(selection.candidate.path, share.target.kind, targetPath) ===
            'missing';
        if (targetMissing) {
          deps.log?.warn(
            { url, project: selection.candidate.path },
            '[receive] target_check=missing — share target not on checked-out branch; dispatching with in-context toast',
          );
        }
        const existing = deps.focusWindowForProject(selection.candidate.path);
        if (existing) {
          deps.sendDeepLink(existing, {
            doc: targetPath,
            kind: share.target.kind,
            branch: share.branch,
            multiCandidate: selection.multiCandidate,
            // Only carry the flag when set — keeps the common (present) case's
            // payload identical to the pre-gate shape.
            ...(targetMissing ? { targetMissing: true } : {}),
          });
          return;
        }
        void deps
          .openProject(selection.candidate.path, {
            pendingDeepLinkTarget: { kind: share.target.kind, path: targetPath },
            pendingBranch: share.branch,
            pendingMultiCandidate: selection.multiCandidate,
            ...(targetMissing ? { pendingTargetMissing: true } : {}),
          })
          .then((win) => {
            // null means the spawn failed AND `openProjectOrFallbackToNavigator`
            // already showed an error dialog + opened an empty Navigator. Surface
            // the share to that Navigator so the user knows what was shared and
            // gets clone/locate options rather than a contextless launcher.
            if (win === null) {
              degradeToLauncherMiss(
                { url, project: selection.candidate.path },
                '[receive] openProject(branch-match-ok) returned null — degrading to launcher-miss',
              );
            }
          })
          .catch((err) => {
            degradeToLauncherMiss(
              {
                url,
                err: err instanceof Error ? err.message : String(err),
                project: selection.candidate.path,
              },
              '[receive] openProject(branch-match-ok) failed — degrading to launcher-miss',
            );
          });
        return;
      }
      case 'fallback': {
        // Project-scoped branch-switch. Warm path: editor already open ->
        // focus + sendShareDeepLink immediately. Cold path: open the editor
        // on its current branch and thread `pendingShareBranchSwitch` so
        // the branch-switch surface mounts on dom-ready.
        const branchSwitch: ShareDeepLinkBranchSwitchPayload = {
          share,
          projectPath: selection.anchor.path,
          currentBranch: selection.anchor.head.currentBranch,
        };
        const existing = deps.focusWindowForProject(selection.anchor.path);
        if (existing) {
          if (deps.sendShareDeepLink) {
            deps.sendShareDeepLink(existing, { kind: 'project-branch-switch', ...branchSwitch });
            return;
          }
          // Window is open but the sender dep is unwired. openProject below
          // focuses the existing window via its early return — BEFORE the
          // pendingShareBranchSwitch gate — so the branch-switch payload would
          // silently drop. Log the missing dep (production always wires it),
          // matching the explicit dep-checks in branch-match-non-ok / miss,
          // then fall through so the window is at least focused.
          deps.log?.warn(
            { url, project: selection.anchor.path },
            '[receive] sendShareDeepLink dep missing — branch-switch payload not delivered to open window',
          );
        }
        void deps
          .openProject(selection.anchor.path, { pendingShareBranchSwitch: branchSwitch })
          .then((win) => {
            if (win === null) {
              degradeToLauncherMiss(
                { url, project: selection.anchor.path },
                '[receive] openProject(branch-switch) returned null — degrading to launcher-miss',
              );
            }
          })
          .catch((err) => {
            degradeToLauncherMiss(
              {
                url,
                err: err instanceof Error ? err.message : String(err),
                project: selection.anchor.path,
              },
              '[receive] openProject(branch-switch) failed — degrading to launcher-miss',
            );
          });
        return;
      }
      case 'branch-match-non-ok': {
        const routeToNav = deps.routeShareToNavigator;
        if (!routeToNav) {
          deps.log?.warn(
            { url },
            '[receive] routeShareToNavigator dep missing — launcher-consent dropped',
          );
          return;
        }
        routeToNav({
          kind: 'launcher-consent',
          share,
          candidatePath: selection.candidate.path,
          parentProjectName: selection.anchorRecent?.name ?? null,
        });
        return;
      }
      case 'miss': {
        const routeToNav = deps.routeShareToNavigator;
        if (!routeToNav) {
          deps.log?.warn(
            { url },
            '[receive] routeShareToNavigator dep missing — launcher-miss dropped',
          );
          return;
        }
        routeToNav({ kind: 'launcher-miss', share });
        return;
      }
      default: {
        // Exhaustiveness guard — a new `CandidateSelection` kind added in
        // core without a matching routing case would land here at runtime.
        const _exhaustive: never = selection;
        deps.log?.warn(
          { url, selection: (_exhaustive as { kind: string }).kind },
          '[receive] unknown CandidateSelection kind — share dropped',
        );
      }
    }
  };

  const routeShare = (url: string, result: ShareParseResult): void => {
    // Diagnostic log first — fires for every share URL the handler sees,
    // including the silent-drop-no-window edge case below. Bracket-prefix
    // namespace per parent spec §6 non-functional / logging conventions.
    if (result.kind === 'unsupported-version') {
      deps.log?.warn(
        { source: result.source, result: result.kind, version: result.version },
        '[receive] action=url-parse',
      );
    } else {
      deps.log?.warn({ source: result.source, result: result.kind }, '[receive] action=url-parse');
    }
    if (result.kind !== 'ok') {
      // Toast-only variants — send to any window via the legacy broadcast
      // path. No resolution required.
      broadcastShareToast(url, { kind: result.kind });
      return;
    }
    // Near-simultaneous-duplicate suppression. A redeemed deferred share and a
    // manual splash re-click for the same target arrive as two `ok` shares with
    // the same `sharedUrl`; route the first, drop the second within the window.
    const now = deps.now ? deps.now() : Date.now();
    const last = shareDedup.get(result.payload.sharedUrl);
    if (last !== undefined && now - last < SHARE_DEDUP_WINDOW_MS) {
      deps.log?.warn({ source: result.source, result: result.kind }, '[receive] action=deduped');
      return;
    }
    shareDedup.set(result.payload.sharedUrl, now);
    for (const [url, ts] of shareDedup) {
      if (now - ts >= SHARE_DEDUP_WINDOW_MS) shareDedup.delete(url);
    }
    const resolver = deps.resolveShareTarget;
    if (!resolver) {
      // Resolution is the decision authority for an `ok` share — without it
      // there is no target to route to. Production main always wires it.
      deps.log?.warn({ url }, '[receive] resolveShareTarget dep missing — share dropped');
      return;
    }
    void resolver(result.payload).then(
      (selection) => dispatchResolvedShare(url, result.payload, selection),
      (err) => {
        // `selectCandidate` degrades to `miss` internally on I/O failure, so a
        // reject here is a near-unreachable defense-in-depth path. Degrade it
        // the same way — route to the Navigator (launcher-miss) so the user
        // gets a forward path (clone / locate manually) rather than a silent
        // drop, uniform with how resolution itself handles failure.
        deps.log?.warn(
          { err: err instanceof Error ? err.message : String(err), url },
          '[receive] resolveShareTarget rejected — degrading to Navigator (miss)',
        );
        dispatchResolvedShare(url, result.payload, { kind: 'miss' });
      },
    );
  };

  const routeScreen = (url: string, screen: ScreenTarget): void => {
    // Entry diagnostic — observability parity with `routeShare`'s url-parse log.
    deps.log?.info?.({ url, screen }, '[url-scheme] routing screen deep link');
    const openScreen = deps.openScreen;
    if (!openScreen) {
      // Screen dep not wired (or a test omitted it). Silent-drop with a warn —
      // production main always wires it.
      deps.log?.warn({ url }, '[url-scheme] openScreen dep missing — screen deep link dropped');
      return;
    }
    // Target the focused window, else any ready one. Settings/install mount in
    // the editor renderer (`App`), so when the resolved window is the Navigator
    // the hash is a no-op — matching the existing app-menu behavior.
    const target = deps.getFocusedWindow?.() ?? deps.getAnyReadyWindow();
    if (!target) {
      deps.log?.warn({ url, screen }, '[url-scheme] no target window — screen deep link dropped');
      return;
    }
    openScreen(target, screen);
  };

  const routeUrl = (url: string): void => {
    const share = parseShareUrl(url);
    if (share !== null) {
      routeShare(url, share);
      return;
    }
    const screen = parseScreenUrl(url);
    if (screen !== null) {
      routeScreen(url, screen.name);
      return;
    }
    // Single-file open (`openknowledge://open?file=<abs>`). Checked before the
    // project-doc parser: both use the `open` host, distinguished by `file` vs
    // `project=&doc=`. The receiver re-derives project-vs-ephemeral (C6).
    const fileOpen = parseOpenKnowledgeFileUrl(url);
    if (fileOpen !== null) {
      const open = deps.openEphemeralFile;
      if (!open) {
        deps.log?.warn(
          { url },
          '[url-scheme] openEphemeralFile dep missing — single-file open dropped',
        );
        return;
      }
      void open(fileOpen.file).catch((err) => {
        deps.log?.warn(
          { err: (err as Error).message, file: fileOpen.file },
          '[url-scheme] openEphemeralFile failed',
        );
      });
      return;
    }
    const parsed = parseOpenKnowledgeUrl(url);
    if (!parsed) {
      // Silent-drop → single warn log line. No error dialog.
      deps.log?.warn({ url }, '[url-scheme] dropped malformed URL');
      return;
    }
    const existing = deps.focusWindowForProject(parsed.project);
    if (existing) {
      // Warm path — renderer subscriber has been mounted for the lifetime of
      // this window. Fire `ok:deep-link` immediately; no dom-ready gate needed.
      // `kind` distinguishes a doc target (`#/<doc>`) from a folder target
      // (`#/<folder>/`); the renderer's `encodeShareTargetForHash` branches on it.
      deps.sendDeepLink(existing, { doc: parsed.doc, kind: parsed.kind });
      return;
    }
    // Cold path — no existing window for this project. Thread the deep-link
    // through `openProject` so `window-manager.createProjectWindow` registers
    // `webContents.once('dom-ready', ...)` BEFORE `loadURL` awaits. This
    // defeats the subscriber-mount race in which
    // `ok:deep-link` fires before main.tsx's `installDeepLinkListener` has
    // attached — which today works only because main.tsx runs synchronously at
    // module-init, a load-bearing assumption we do NOT want to depend on.
    //
    // `openProject` returns `null` when the spawn failed AND the error was
    // surfaced to the user (dialog + Navigator fallback). Nothing to do here
    // in that case — the dom-ready hook registered at spawn time is what would
    // have fired the event, but there's no window to receive it.
    void deps
      .openProject(parsed.project, {
        pendingDeepLinkTarget: { kind: parsed.kind, path: parsed.doc },
      })
      .catch((err) => {
        deps.log?.warn(
          { err: (err as Error).message, project: parsed.project },
          '[url-scheme] openProject failed',
        );
      });
  };

  // Drain every queued URL, bypassing the auto-flush's `getAnyReadyWindow()`
  // gate. Shared by the auto-flush loop (after a window exists / retries expire)
  // and the boot path's `drainQueuedUrls` (which has suppressed the default
  // window, so no window will appear for the gate to wait on). Idempotent.
  const drainAll = (): void => {
    flushed = true;
    while (urlQueue.length > 0) {
      const next = urlQueue.shift();
      if (next) routeUrl(next);
    }
  };

  const enqueueOrRoute = (url: string): void => {
    // A single-file open (`ok <file>` → `openknowledge://open?file=`) claims this
    // launch — record it (queued OR routed) so the cold-start boot path opens
    // ONLY the file window, not the previous-project / Navigator default that
    // would race it for focus and surface the empty-state splash. Mirrors
    // routeUrl's file-branch parser; a malformed file URL (null parse) doesn't
    // claim the launch (it routes to a warn-drop, default window stays).
    const isSingleFile = parseOpenKnowledgeFileUrl(url) !== null;
    if (isSingleFile) {
      singleFileLaunch = true;
    }
    // A launch-claiming URL that opens its OWN window must suppress the default
    // boot-restore window so the flush owns the launch — else the previously-
    // opened project opens instead of the shared target. Covers single-file
    // opens AND valid (`ok`) shares (which dispatch to a project window or the
    // Navigator). An invalid/unsupported share is EXCLUDED: its toast needs a
    // pre-existing window to land in (so does a `screen` deep-link, which
    // `parseShareUrl` returns null for). Mirrors routeUrl's parser — same
    // double-parse pattern as the single-file branch above.
    if (isSingleFile || parseShareUrl(url)?.kind === 'ok') {
      urlLaunchOwnsWindow = true;
    }
    if (flushed) {
      routeUrl(url);
    } else {
      urlQueue.push(url);
    }
  };

  // `open-url` — macOS Apple Event path (the primary warm/cold delivery
  // channel). `preventDefault` silences Electron's default "log to stderr"
  // behavior and signals we've handled the event.
  deps.app.on('open-url', (event, url) => {
    event.preventDefault();
    enqueueOrRoute(url);
  });

  // `continue-activity` — macOS Handoff path for Universal Links. Fires when
  // the user taps `https://openknowledge.ai/d/<encoded>` in Slack/iMessage
  // (or any AASA-eligible surface) and the OS routes the activity into OK.
  // The activity type for tapped-link Handoff is always
  // `NSUserActivityTypeBrowsingWeb`; the URL lives on `details.webpageURL`
  // per modern Electron's `ContinueActivityDetails`, but we also accept
  // `userInfo.webpageURL` defensively (matches older Electron shapes + the
  // story's AC text).
  //
  // The listener registers harmlessly even before the Apple-gated
  // entitlement + provisioning profile land — it never fires until the
  // signed app activates Universal Links. Host-gate before
  // `enqueueOrRoute` so non-matching Handoff activities (e.g., a future
  // `NSUserActivityTypeBrowsingWeb` from an unrelated webpage) cannot
  // poison the queue with arbitrary URLs.
  deps.app.on('continue-activity', (event, type, userInfo, details) => {
    if (type !== 'NSUserActivityTypeBrowsingWeb') return;
    const webpageURL =
      readWebpageURL(details) ?? readWebpageURL(userInfo as { webpageURL?: unknown } | undefined);
    if (!webpageURL) return;
    let host: string;
    try {
      host = new URL(webpageURL).hostname.toLowerCase();
    } catch {
      return;
    }
    if (!SHARE_UNIVERSAL_LINK_HOSTS.has(host)) return;
    // Signal to AppKit that we've taken ownership of the activity — keeps
    // the OS from emitting `continue-activity-error` for a no-op handler.
    event.preventDefault();
    deps.log?.warn({ type, urlHost: host }, '[receive] action=continue-activity-received');
    enqueueOrRoute(webpageURL);
  });

  // `second-instance` — fires when a duplicate process invocation is denied
  // by `requestSingleInstanceLock` (caller MUST acquire the lock in
  // `main/index.ts` before `registerProtocolHandler` runs, or this listener
  // is dead code — Electron only emits `second-instance` on the primary
  // when the lock machinery is active). CLI launches and dev launches carry
  // the URL in argv rather than firing an Apple Event.
  deps.app.on('second-instance', (_event, argv) => {
    for (const arg of argv) {
      if (typeof arg === 'string' && arg.startsWith('openknowledge://')) {
        enqueueOrRoute(arg);
      }
    }
  });

  // Cold-start CLI-launch scan: on the primary instance's initial boot,
  // `process.argv` is the delivery surface for direct-binary launches (the
  // `second-instance` handler above only catches SECOND invocations). We
  // scan argv once here, synchronously, so a user running
  // `./OK.app/Contents/MacOS/Open\ Knowledge openknowledge://...` on a
  // not-yet-running app gets the URL queued alongside any Apple-Event
  // deliveries. Electron shell launches with no URL (the normal case)
  // produce zero matches.
  const initialArgv = deps.getInitialArgv ? deps.getInitialArgv() : [];
  for (const arg of initialArgv) {
    if (typeof arg === 'string' && arg.startsWith('openknowledge://')) {
      enqueueOrRoute(arg);
    }
  }

  // Flush loop — after `whenReady`, wait for any BrowserWindow to be up
  // before draining the queue. URLs routed while the window manager is still
  // booting would either crash or vanish; the 10 × 500ms retry is the VS
  // Code `ElectronURLListener` convention.
  void deps.app.whenReady().then(() => {
    const tryFlush = (attempt: number): void => {
      if (urlQueue.length === 0 || deps.getAnyReadyWindow()) {
        drainAll();
        return;
      }
      if (attempt >= QUEUE_FLUSH_MAX_ATTEMPTS) {
        // Out of retries with a window still missing. Drain what we have so
        // we don't leak the queue — `routeUrl` will spawn a project window
        // on demand via `openProject`.
        drainAll();
        return;
      }
      schedule(() => tryFlush(attempt + 1), QUEUE_FLUSH_INTERVAL_MS);
    };
    tryFlush(0);
  });

  return {
    singleFileLaunch: () => singleFileLaunch,
    urlLaunchOwnsWindow: () => urlLaunchOwnsWindow,
    // Already-flushed (auto-flush won the race, or a no-URL launch) → no-op via
    // the empty queue; otherwise drains immediately for the suppress path.
    drainQueuedUrls: () => drainAll(),
    routeUrl: (url) => enqueueOrRoute(url),
  };
}
