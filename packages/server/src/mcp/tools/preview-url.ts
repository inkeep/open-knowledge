/**
 * Resolve the per-doc preview ROUTE for a given wiki docName.
 *
 * `resolvePreviewUrl` returns a route only (`/#/{docName}`) — no scheme,
 * host, or port. It still reads `ui.lock` for reachability: a non-null
 * result means a UI is running for the project (the route is navigable);
 * `null` means no UI is running anywhere. The route rides on every read +
 * write tool response so the attach-preview-once warning flow keys off it.
 *
 * The browser-reachable BASE (`http://localhost:<port>`) deliberately does
 * NOT ride per-response payloads — it lived in `previewUrl` and the now-removed
 * `ui` block, where a port the agent often must not use (the live UI behind
 * the Claude Code lock-collision proxy is reachable only on the proxy port)
 * sat in front of every tool call. The base now lives in exactly one place an
 * agent reaches deliberately: the `preview_url` tool, which composes
 * `resolveUiInfo`'s base with `resolvePreviewUrl`'s route on demand.
 *
 * Route shape: `/#/{docName}` with per-segment encodeURIComponent. Matches
 * the hash-route parser in `packages/app/src/lib/doc-hash.ts`.
 *
 * Both CLI (`ok ui`) and OK Electron write `ui.lock`, so the lock branch
 * fires universally whenever any UI is running for the project. The
 * `openknowledge://` URL scheme stays load-bearing for OS-level deep-linking
 * (URL-scheme handler, dock drag, sidebar pills) — but is no longer emitted
 * as an MCP `previewUrl`, because external agent in-app browsers (Claude
 * Desktop, Cursor, Codex) cannot render custom URL schemes.
 *
 * Two further base sources — `env` (OPEN_KNOWLEDGE_PREVIEW_BASE_URL) and
 * `config` (preview.baseUrl) — existed for production-deployed-wiki use
 * cases. Both came out when the schema field went away; reintroduce them
 * together (in `resolveUiInfo`) if a deployed-wiki configuration knob is
 * ever needed again.
 */
import { resolveLockDir } from '../../config/paths.ts';
import { readUiLock } from '../../ui-lock.ts';
import type { ConfigOrResolver } from './shared.ts';

export const PREVIEW_URL_SOURCES = ['lock'] as const;
export type PreviewUrlSource = (typeof PREVIEW_URL_SOURCES)[number];

interface PreviewUrlResult {
  /** Route-only preview URL: `/#/{docName}`. No scheme, host, or port. */
  url: string;
  source: PreviewUrlSource;
}

export interface PreviewUrlContext {
  lockDir: string;
}

/**
 * Common deps shape for MCP tool handlers that need to resolve preview URLs.
 * `resolveCwd` is the per-call cwd resolver (see `ResolveCwd` in tools/index.ts).
 * `config` is reserved for future resolver work (e.g., reintroducing the
 * `env`/`config` sources for deployed-wiki use cases) — accepted but not
 * currently dereferenced by the resolver itself.
 */
export interface PreviewUrlDeps {
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
}

/** Encode a docName into the hash fragment, per-segment. */
export function encodeDocName(docName: string): string {
  return docName.split('/').map(encodeURIComponent).join('/');
}

/**
 * Encode a folder path into a `<folder>/` route-fragment body (trailing slash,
 * no leading `#/`). Pair with a `#/` prefix to form the `#/<folder>/` route the
 * hash parser in `packages/app/src/lib/doc-hash.ts` expects.
 */
export function encodeFolderRoute(folder: string): string {
  const normalized = folder.replace(/^\/+|\/+$/g, '');
  return normalized ? `${encodeDocName(normalized)}/` : '';
}

/**
 * Encode a skill into the `__skill__/<scope>/<name>` route-fragment body (no
 * leading `#/`). Pair with a `#/` prefix to form the skill route the hash parser
 * in `packages/app/src/lib/doc-hash.ts` (`docNameFromHash`) expects. Single home for
 * the `__skill__` literal — shared by `resolveSkillPreviewUrl` and `preview_url`.
 */
export function encodeSkillRoute(scope: string, name: string): string {
  return `__skill__/${scope}/${encodeDocName(name)}`;
}

/**
 * Warning shape emitted on write/list-tool responses when the server reports
 * `systemSubscriberCount === 0` (no editor is attached to `__system__`).
 *
 * Two variants share the `previewUrl + message + autoOpen` shape but differ
 * on `action`:
 *   - `attach-preview-once` — `previewUrl` is non-null; agent opens it once
 *     to attach a browser. Server tracks `__system__` subscribers so the
 *     hint fires at most once per session in the fresh-start case.
 *   - `start-ui` — `previewUrl` is null; no UI is running anywhere for this
 *     project. Agent advises the user to start one (`ok ui`
 *     from a terminal, `preview_start("open-knowledge-ui")` in Claude
 *     Code Desktop, or just open the project in OK Electron).
 *
 * Both pin the same `previewUrl` field so a single agent-side branch can
 * read either: if non-null → open; if null → tell user to start a UI.
 * Both also carry the user-scoped `autoOpen` preference resolved fresh per
 * tool call (`appearance.preview.autoOpen`). When `autoOpen` is `false`, the
 * user is managing their own preview view (OK Desktop window, browser tab
 * they opened) — the agent MUST NOT navigate or refresh any preview UI, even
 * when this warning fires. Routing stays the same — `previewUrl` still rides
 * the response — only the agent's open-or-skip decision changes. The field
 * carries no behavioral signal on the `start-ui` variant (`previewUrl: null`,
 * no preview to open or skip); it rides both variants for a uniform shape so
 * agents read `warning.autoOpen` without branching on the discriminator.
 */
type PreviewAttachWarning =
  | {
      action: 'attach-preview-once';
      previewUrl: string;
      message: string;
      autoOpen: boolean;
    }
  | {
      action: 'start-ui';
      previewUrl: null;
      message: string;
      autoOpen: boolean;
    };

const START_UI_MESSAGE =
  'No UI is running for this project. Start one to see the preview: `ok ui` (terminal), `preview_start("open-knowledge-ui")` (Claude Code Desktop), or open the project in OK Electron.';
const ATTACH_PREVIEW_ONCE_MESSAGE =
  "No browser is attached to the preview. Open it in your host's surface: `preview_start` (Claude Code Desktop pane), or `preview_url` then navigate your in-app browser to the url (Cursor's `Navigate` / Codex desktop `@Browser`); on the Claude Code CLI, `ok open <doc>`.";

/**
 * Build the per-response warning emitted when the server reports zero
 * `__system__` subscribers. Picks `start-ui` vs `attach-preview-once`
 * based on whether the lock-resolved preview URL exists. Always returns
 * a warning — callers gate the call site on `systemSubscriberCount === 0`
 * (no warning fires when a browser is already attached).
 *
 * `autoOpen` is the resolved `appearance.preview.autoOpen` boolean for the
 * current tool call; rides both variants so agents reading either shape
 * make the same open-or-skip decision off a single field.
 */
export function buildPreviewAttachWarning(
  preview: { url: string } | null,
  autoOpen: boolean,
): PreviewAttachWarning {
  if (preview) {
    return {
      action: 'attach-preview-once',
      previewUrl: preview.url,
      message: ATTACH_PREVIEW_ONCE_MESSAGE,
      autoOpen,
    };
  }
  return {
    action: 'start-ui',
    previewUrl: null,
    message: START_UI_MESSAGE,
    autoOpen,
  };
}

/**
 * The plain-text variant of the `start-ui` message — used in the
 * response's `text` body alongside the structured `warning` field so
 * agents that only surface `_text` still see the recovery options.
 * Kept in sync with `START_UI_MESSAGE` by exporting it from the same
 * module.
 */
export const START_UI_TEXT_HINT = START_UI_MESSAGE;

/**
 * Convenience wrapper for MCP tool handlers: resolves cwd via `deps.resolveCwd`,
 * derives lockDir against the project root (cwd), then delegates to
 * `resolvePreviewUrl`. Keeps the "cwd → lockDir → resolve" boilerplate in one
 * place so all single-doc tools emit previewUrl the same way.
 *
 * Lock anchor is the project root (cwd), not contentDir — must match
 * `server-factory.ts`'s `<projectDir>/.ok/local/server.lock` so the running
 * server is discoverable when `content.dir` is a sub-folder.
 */
export async function resolvePreviewUrlForTool(
  docName: string,
  deps: PreviewUrlDeps,
  cwd?: string,
): Promise<PreviewUrlResult | null> {
  const effectiveCwd = cwd ?? (await deps.resolveCwd());
  // Lock anchor is the project root (cwd), not contentDir — see server-factory.ts.
  const lockDir = resolveLockDir(effectiveCwd);
  return resolvePreviewUrl(docName, { lockDir });
}

/**
 * Browser-reachable UI info — resolved on demand by the `preview_url`
 * tool, NOT emitted on per-response payloads. `baseUrl` is the
 * browser-reachable origin of the `ok ui` process; null when the UI lock is
 * absent / stale / unbound.
 */
export interface UiInfo {
  baseUrl: string | null;
}

/**
 * Pure helper: given a resolved lockDir, return the browser-reachable UI
 * origin if the lock points at a live, bound UI process. Never throws.
 *
 * Internal helper consumed by the `preview_url` tool — the only surface
 * that hands an agent the preview base/port. List-producing tools no longer
 * emit a `ui` block, so the base does not ride per-response payloads.
 */
export function resolveUiInfo(ctx: PreviewUrlContext): UiInfo {
  try {
    const lock = readUiLock(ctx.lockDir);
    if (lock && lock.port > 0) {
      return { baseUrl: `http://localhost:${lock.port}` };
    }
  } catch (err) {
    process.stderr.write(
      `[preview-url] readUiLock failed at ${ctx.lockDir} while resolving ui info: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return { baseUrl: null };
}

/**
 * Poll `resolveUiInfo` until the UI lock binds (`port > 0`) or the deadline
 * passes. Used by `preview_url` right after a fresh backend spawn: `ok start`
 * spawns its `ok ui` sibling asynchronously, so `ui.lock` lags `server.lock`
 * by up to a few seconds on a cold start (the server's own sibling wait is
 * `uiBindTimeoutMs` in `bootStartServer`). Also rides out the desktop
 * single-origin window where `ui.lock` exists at port 0 until the server
 * binds and calls `updateUiLockPort`.
 */
export async function awaitUiBaseUrl(
  ctx: PreviewUrlContext,
  opts: { timeoutMs: number; pollIntervalMs: number },
): Promise<string | null> {
  const deadline = Date.now() + opts.timeoutMs;
  while (true) {
    const { baseUrl } = resolveUiInfo(ctx);
    if (baseUrl !== null) return baseUrl;
    if (Date.now() >= deadline) return null;
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, opts.pollIntervalMs));
  }
}

/**
 * Per-call helper for list-producing tools. Resolves cwd once, then returns
 * a `resolve(docName)` closure used to enrich every row in a list response
 * with a route-only `previewUrl`.
 *
 * Docs tools call this once per invocation, then thread the returned `resolve`
 * over their result rows. Keeps the cwd/lockDir derivation out of tight loops.
 * No top-level `ui` block is returned — the browser base lives only behind
 * the `preview_url` tool.
 */
export async function buildListResolver(
  deps: PreviewUrlDeps,
  cwd?: string,
): Promise<{ resolve(docName: string): PreviewUrlResult | null }> {
  const effectiveCwd = cwd ?? (await deps.resolveCwd());
  // Lock anchor is the project root (cwd), not contentDir — see server-factory.ts.
  const lockDir = resolveLockDir(effectiveCwd);
  const ctx: PreviewUrlContext = { lockDir };
  return {
    resolve: (docName: string) => resolvePreviewUrl(docName, ctx),
  };
}

/**
 * Normalize a file path (possibly with `.md` / `.mdx`) to an extension-less
 * docName suitable for previewUrl resolution. Falls back to the input
 * unchanged for extension-less paths (matches `normalizeDocName` policy).
 */
export function docNameFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md')) return path.slice(0, -3);
  if (lower.endsWith('.mdx')) return path.slice(0, -4);
  return path;
}

/**
 * Resolve the route-only preview URL (`/#/{docName}`) for a docName. Returns
 * `null` when no UI is running for the project (`ui.lock` absent / unbound).
 *
 * The returned `url` is a ROUTE — no scheme, host, or port. The lock is read
 * only for reachability (a non-null result means the route is navigable in a
 * running UI). The browser base is composed on demand by `preview_url`.
 */
export function resolvePreviewUrl(
  docName: string,
  ctx: PreviewUrlContext,
): PreviewUrlResult | null {
  return previewForRoute(`/#/${encodeDocName(docName)}`, ctx);
}

/**
 * Resolve the route-only preview URL for a skill (`/#/__skill__/{scope}/{name}`).
 * Skills are non-CRDT but the editor renders them in the main pane like a doc and
 * the route is addressable (see `hashFromDocName` in `packages/app/src/lib/doc-hash.ts`),
 * so write/edit responses ride a `previewUrl` the agent can open — same contract
 * as documents. `null` when no UI is running for the project.
 */
export function resolveSkillPreviewUrl(
  scope: string,
  name: string,
  ctx: PreviewUrlContext,
): PreviewUrlResult | null {
  return previewForRoute(`/#/${encodeSkillRoute(scope, name)}`, ctx);
}

/**
 * Shared reachability gate for the route resolvers: returns the route verbatim
 * (no scheme/host/port) when `ui.lock` reports a running UI, else `null`.
 *
 * The lock is read only for reachability — server.lock points at collab-only in
 * the post-split lifecycle; ui.lock (CLI `ok ui` + OK Electron) is the universal
 * signal that a navigable React app exists.
 */
function previewForRoute(hash: string, ctx: PreviewUrlContext): PreviewUrlResult | null {
  try {
    const lock = readUiLock(ctx.lockDir);
    if (lock && lock.port > 0) {
      return { url: hash, source: 'lock' };
    }
  } catch (err) {
    // Lock file exists but is corrupt or unreadable. No further sources
    // remain in the chain — surface the error so operators debugging
    // "why won't the preview URL resolve?" aren't left in the dark.
    process.stderr.write(
      `[preview-url] readUiLock failed at ${ctx.lockDir}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  return null;
}
