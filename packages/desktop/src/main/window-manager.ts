/**
 * Main-process window manager — spawns BrowserWindow + utilityProcess pairs
 * per project, with an attach branch that reuses an existing live same-host
 * OpenKnowledge server (CLI sibling, another Electron instance, or any
 * bootServer caller).
 *
 * Each project window either:
 *   - (spawn mode, the common case) owns one `utilityProcess.fork` with
 *     `windowLifecycleBound: true, windowLifecycleGraceTime: 6000` + a
 *     BrowserWindow with preload-injected `--ok-collab-url` argv flags.
 *   - (attach mode) just owns the BrowserWindow;
 *     `window.okDesktop.config.collabUrl` points at the already-listening
 *     server, nothing is torn down on close. `ProjectContext.ownsServer ===
 *     false` gates every lifecycle action.
 *
 * Attach trigger: `<contentDir>/.ok/local/server.lock` references a
 * live same-host pid with `port > 0`. Stale locks flow through `runClean`
 * first, then spawn-mode proceeds.
 *
 * If a project's contentDir is already open in another window of THIS app,
 * surface "Focus existing window" instead of spawning a duplicate. Tracked
 * via `Map<contentDir, ProjectContext>`.
 *
 * Pure factories take injected `electron` deps so tests don't need a real
 * Electron runtime.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SIGTERM_GRACE_MS,
  DEFAULT_SIGTERM_POLL_MS,
  SPAWN_ERROR_LOG,
  sliceLastSpawnAttempt,
} from '@inkeep/open-knowledge-core';
import type { KeepaliveHandle } from '@inkeep/open-knowledge-core/keepalive';
import { getLocalDir } from '@inkeep/open-knowledge-server';
import type { OkServerRestartOutcome } from '../shared/bridge-contract.ts';
import { registerPendingDelivery } from '../shared/ipc-send.ts';
import type { AssetOpenResult } from './asset-allowlist.ts';
import { attachAssetSafetyNet } from './asset-safety-net.ts';
import type { ServerExitInfo } from './server-exit-record.ts';
import type { ShowGateRegistry } from './show-gate.ts';
import type { RestoredWindow } from './state-store.ts';
import type { ShareDeepLinkBranchSwitchPayload } from './url-scheme.ts';
import { classifyServerVersion } from './version-drift.ts';

/**
 * SIGTERM grace for a user-initiated server restart, shorter than the
 * auto-update teardown's `DEFAULT_SIGTERM_GRACE_MS` (10 s). The user explicitly
 * asked to restart and was warned agents disconnect, so we escalate to SIGKILL
 * sooner rather than waiting out a slow graceful shutdown. Auto-update keeps the
 * gentle 10 s so in-flight agent writes get a fuller drain before a full relaunch.
 */
const RESTART_SIGTERM_GRACE_MS = 3_000;

/**
 * How long a freshly-spawned detached server has to show ANY sign of life
 * before the parent gives up on it. Reached with the child alive, this is not
 * a kill deadline — see `spawnLockProgressDeadlineMs`.
 */
const DEFAULT_SPAWN_STARTUP_DEADLINE_MS = 15_000;

/**
 * Multiple of the startup deadline that a still-alive child is allowed to run
 * to before the wait is abandoned (15 s → 120 s at the shipped default).
 * Sized to clear the pre-listen boot phase on a large working copy — that
 * phase grows with project state and has no upper bound in the server today —
 * while still failing eventually if the process is genuinely wedged.
 *
 * Derived from the startup deadline rather than fixed so the two stay in
 * proportion however the first is configured.
 */
const SPAWN_WAIT_EXTENSION_FACTOR = 8;

/**
 * How many times a foreign lock is probed before a caller acts on the answer,
 * and how long it waits between tries. Shared by the detached-spawn gate and
 * the recovery that breaks a stale claim. See `probeForeignLockWithGrace`.
 */
const FOREIGN_LOCK_PROBE_ATTEMPTS = 3;
const FOREIGN_LOCK_PROBE_RETRY_MS = 500;

/**
 * Which decision a health probe is informing. The `desktop-attach-refused`
 * event predates every caller but the attach gate, so without this a bundle
 * reads a restart-recovery refusal and an attach-gate refusal as the same
 * verdict twice on one port.
 */
type ProbePhase = 'attach' | 'spawn-foreign-lock' | 'restart-recovery' | 'force-stop-recovery';

/**
 * Whether a lock's `port` is something we can actually dial.
 *
 * `lock.port` is TYPED `number` but never validated at runtime on this path:
 * `readProcessLock` checks only `pid` and then casts. So `undefined`, `Infinity`,
 * `70000`, `1.5` and even a string all reach us, and every one of them survives
 * a `port <= 0` test — `undefined <= 0` is a NaN comparison, hence `false`.
 * Each then formats into `http://localhost:undefined`-shaped garbage, the probe
 * throws, `probeAttachableLock` swallows it as "not serving", and a lock we had
 * no business touching gets unlinked. Testing dialability rather than sign is
 * what closes that.
 */
function isDialablePort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535;
}

/** The two entry states that can meet an unkillable lock holder. */
type RecoveryCaller = 'restart' | 'force-stop';

/**
 * Pairs each recovery entry state's log event with its probe phase, so the two
 * cannot drift apart. Not the single source of the event NAME — the same
 * literals are set independently at the other log sites in these two methods;
 * this owns only the pairing.
 */
const RECOVERY_CALLERS: Record<
  RecoveryCaller,
  { event: 'desktop-server-restart' | 'desktop-force-stop-conflicting-server'; phase: ProbePhase }
> = {
  restart: { event: 'desktop-server-restart', phase: 'restart-recovery' },
  'force-stop': {
    event: 'desktop-force-stop-conflicting-server',
    phase: 'force-stop-recovery',
  },
};

/**
 * Cadence (ms) of the ephemeral single-file session's server-liveness poll. An
 * ephemeral server is a DETACHED process whose lifetime is decoupled from its
 * window's, so it can die (kill / crash / idle-shutdown) while the window stays
 * open. The spawner observes the child's `'exit'` but exposes it only as a pull
 * snapshot (`readExit`), not a push signal to this class — so this poll is how
 * the window manager proactively notices a dead session and reaps it. A few
 * seconds is well inside human re-open latency while staying a cheap
 * `process.kill(pid, 0)` probe. Tests inject `deps.setInterval` (see
 * `wireIntervalTimers` / `tick` in the ephemeral-window test suite) to advance
 * it deterministically.
 */
const EPHEMERAL_SERVER_WATCH_POLL_MS = 3_000;

/**
 * Local mirror of `isValidLockPid` from `@inkeep/open-knowledge-server`. Same
 * import-surface rationale as `isProcessAliveLocal` above.
 *
 * Range-check a value parsed from `<lockDir>/server.lock`'s `pid` field
 * before any code path that could send a signal to it. Rejects PID `0`
 * (kills the process group under POSIX), PID `1` (init/launchd; SIGTERM
 * delivery may EPERM but the auto-kill code would still attempt it),
 * negatives (process-group syntax), non-integers, and values outside the
 * conservative 2..2^31-1 range. The lock file lives under
 * `<contentDir>/.ok/`, which on shared volumes / `/tmp` projects / multi-
 * user hosts is writable by processes other than the lock holder — so a
 * tampered lock could otherwise steer collision-recovery into signaling an
 * unrelated PID.
 *
 * NOTE: this validator deliberately accepts `process.pid` so the read path
 * for our own legitimate lock continues to work. The desktop's auto-kill
 * code site adds the `holderPid !== process.pid` check separately.
 */
function isValidLockPidLocal(value: unknown): value is number {
  if (typeof value !== 'number') return false;
  if (!Number.isInteger(value)) return false;
  if (value < 2) return false;
  if (value > 0x7fffffff) return false;
  return true;
}

/**
 * Optional per-instance label (set at boot from the launch's `userData` name by
 * the parallel-instance launcher or dev `OK_INSTANCE`). When present it is
 * appended to editor window titles so concurrent instances are distinguishable
 * in Mission Control / the Window menu. Null for the default install.
 */
let windowInstanceLabel: string | null = null;

/** Set the per-instance label woven into {@link formatEditorTitle}. */
export function setWindowInstanceLabel(label: string | null): void {
  windowInstanceLabel = label;
}

/**
 * `--ok-instance-label` preload arg for the current named instance, spread into
 * each editor window's `additionalArguments` so the renderer can show the
 * branch/worktree badge in the header. Present only for a named parallel
 * instance; the default install omits it (preload coerces absent → null).
 */
function instanceLabelArgs(): string[] {
  return windowInstanceLabel ? [`--ok-instance-label=${windowInstanceLabel}`] : [];
}

/**
 * Editor window title format — `<projectName> — OpenKnowledge`, plus a
 * ` (<instance>)` suffix when this is a named parallel instance. The em dash
 * + app-name suffix follows the macOS/VS Code/Cursor convention: the project
 * name leads so users can scan the Dock / Cmd-Tab switcher by content, and
 * the app branding is retained as a recognizable tail.
 *
 * Navigator windows use a static "OpenKnowledge" title set in
 * `navigator-window.ts` — no project context there to prepend.
 */
function formatEditorTitle(projectName: string): string {
  const suffix = windowInstanceLabel ? ` (${windowInstanceLabel})` : '';
  return `${projectName} — OpenKnowledge${suffix}`;
}

/** Subset of `electron.BrowserWindow` we use — keeps tests Electron-free. */
export interface BrowserWindowLike {
  focus(): void;
  /**
   * Display the OS-level window. Now the primary first-paint mechanism for
   * cold launch — every window factory (`createProjectWindow`,
   * `createNavigatorWindow`, `attachToExistingServer`) registers a
   * `once('ready-to-show')` listener that calls this, plus a 5 s safety
   * timeout that does the same. Also used by the URL-scheme deep-link
   * focus-or-create flow. Optional in the structural type because some test
   * mocks omit it; `?.show()` callers no-op silently when missing.
   */
  show?(): void;
  /**
   * Display the OS-level window WITHOUT taking focus. On macOS a plain
   * `show()` activates the whole app — it pulls OpenKnowledge in front of
   * whatever the user switched to — whereas `showInactive()` reveals the
   * window and leaves the foreground app alone. That difference is what keeps
   * a multi-window session restore from yanking the user back once per
   * window. Optional in the structural type because some test mocks omit it;
   * callers fall back to `show()`.
   */
  showInactive?(): void;
  restore?(): void;
  isMinimized?(): boolean;
  /**
   * `true` when the underlying Electron native window has been destroyed.
   * Optional for tests — when omitted, we assume the window is alive and
   * skip the destroyed-guard. Production wiring uses Electron's
   * `BrowserWindow.isDestroyed()`.
   */
  isDestroyed?(): boolean;
  /**
   * `true` when the native window has been shown and is on screen. Optional
   * for tests — when omitted, the safety-timeout treats the window as
   * not-yet-visible and triggers `show()`.
   */
  isVisible?(): boolean;
  /**
   * Raise this window above its siblings in the window stack. Pairs with the
   * app-level activation (`WindowManagerDeps.activateApp`) in the
   * bring-to-front recipe — on macOS `focus()` alone moves z-order within the
   * app but does not foreground a backgrounded app (electron/electron#19920).
   * Optional for test mocks.
   */
  moveTop?(): void;
  /**
   * `true` when this window is the OS key/focused window. Used to skip the
   * focus-steal when the window is already frontmost (e.g. the OK Desktop
   * built-in terminal focusing a doc in its own already-active window — no
   * steal needed). Optional for test mocks.
   */
  isFocused?(): boolean;
  /**
   * Programmatically close the window. Real Electron always has this; marked
   * optional because some test mocks omit it. Used by main to dismiss the
   * Navigator after a project window resolves.
   */
  close?(): void;
  /**
   * Force-destroy the native window without firing `beforeunload`. Optional in
   * the structural type (test mocks may omit). Used by `closeAndAwait` to clear
   * a window wedged past the close grace so a server restart can't strand it.
   */
  destroy?(): void;
  on(event: 'closed', cb: () => void): void;
  /**
   * One-shot listener for the BrowserWindow's `ready-to-show` event — fires
   * when Chromium has prepared an offscreen frame for the first paint. All
   * three window factories (`createProjectWindow`, `attachToExistingServer`,
   * `createNavigatorWindow`) register this so they can defer `show()` until
   * the renderer is ready, eliminating the OS-level white-flash band.
   */
  once(event: 'ready-to-show', cb: () => void): void;
  webContents: {
    send(channel: string, ...args: unknown[]): void;
    once(event: 'dom-ready' | 'did-finish-load', cb: () => void): void;
    /**
     * Run a string of JS in the renderer. Used by the URL-scheme `screen`
     * deep-link handler to navigate `window.location.hash`. Matches Electron's
     * `WebContents.executeJavaScript` at runtime.
     */
    executeJavaScript(code: string): Promise<unknown>;
    /**
     * `will-navigate` / `will-redirect` + `setWindowOpenHandler` used by the
     * asset-click safety net and the slides-window origin containment.
     * `will-redirect` shares `will-navigate`'s `(event, url)` shape (its extra
     * trailing args are unused here). Narrow structural signature — tests that
     * don't exercise these can leave them as no-ops. Matches Electron's
     * `WebContents` at runtime.
     */
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void;
    on(
      event: 'will-navigate' | 'will-redirect',
      handler: (event: { preventDefault: () => void }, url: string) => void,
    ): void;
  };
  loadFile(filePath: string): Promise<void>;
  loadURL(url: string): Promise<void>;
}

/** Subset of `electron.utilityProcess.fork`'s return — shape we use. */
export interface UtilityProcessLike {
  pid: number | undefined;
  postMessage(msg: unknown): void;
  on(event: 'message', cb: (msg: unknown) => void): void;
  on(event: 'exit', cb: (code: number | null) => void): void;
  once(event: 'message', cb: (msg: unknown) => void): void;
  removeListener?(event: 'message', cb: (msg: unknown) => void): void;
  removeListener?(event: 'exit', cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * Minimal shape of `server.lock` metadata that the attach probe consumes.
 * Intentionally structural (not imported from `@inkeep/open-knowledge-server`)
 * to keep this module runtime-independent of the server package — the real
 * shape is `ServerLockMetadata` from process-lock.ts and is type-compatible.
 *
 * `kind` and `capabilities` are optional for legacy-lock tolerance — locks
 * written by older binaries omit them, and the desktop conservatively
 * refuses to attach when any are absent (forces a fresh spawn rather than
 * risk attaching to a server with unknown semantics).
 */
export interface ServerLockMetadataLike {
  pid: number;
  hostname: string;
  port: number;
  /**
   * One-URL contract origin (see the server package's `process-lock.ts`):
   * every surface of the holder is reachable at this base. Optional for
   * legacy-lock tolerance; `lockApiOrigin` below prefers it and falls back
   * to `port`.
   */
  url?: string;
  startedAt: string;
  worktreeRoot: string;
  kind?: 'interactive' | 'mcp-spawned';
  capabilities?: string[];
  /**
   * Version the server self-describes (written by `acquireProcessLock`).
   * Both optional — locks written by binaries predating the version contract
   * omit them; the version-drift classifier treats a missing field as
   * indeterminate (no notification).
   */
  protocolVersion?: number;
  runtimeVersion?: string;
  /**
   * Stable machine identity (see server package `machine-id.ts`). Locks that
   * carry it are machine-checked by `readServerLock` itself; absence means a
   * legacy lock where hostname comparison is the only provenance signal.
   */
  machineId?: string;
  /**
   * Holder has begun teardown but still owns the lock until process exit.
   * Draining locks are neither attachable nor a spawn-readiness signal.
   */
  draining?: boolean;
}

/**
 * The loopback origin a lock's `url` field yields, or `null` when it yields
 * none. Extracted so `lockApiOrigin` and anything reasoning about whether a
 * lock is dialable at all read the SAME precedence — a second copy of this
 * check drifting from the first is how a lock with a good `url` and a garbage
 * `port` came to look unreachable.
 */
function loopbackOriginFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // WHATWG URL keeps the brackets in `hostname` for IPv6 literals.
  const host = parsed.hostname;
  const loopback =
    host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  return loopback ? parsed.origin : null;
}

/**
 * Whether anything could be listening at what this lock names — the question
 * the BREAK path asks, because breaking without a probe is only safe when the
 * answer is no.
 *
 * Deliberately permissive about `port`. `lockApiOrigin` renders a numeric
 * STRING into `http://localhost:42117`, which is a perfectly live address, so
 * a server can be behind a lock that shape. Treating it as nothing-there would
 * destroy a claim we could have dialed.
 */
function lockMayHaveServer(lock: { port?: unknown; url?: unknown }): boolean {
  if (loopbackOriginFromUrl(lock.url) !== null) return true;
  const port = typeof lock.port === 'string' ? Number(lock.port) : lock.port;
  return isDialablePort(port);
}

/**
 * Whether we can ATTACH to what this lock names — a strictly narrower question
 * than `lockMayHaveServer`, and the reason the two exist separately.
 *
 * A numeric string can have a server behind it, but the session we would build
 * on top cannot carry it: `resolveKeepaliveWsOrigin` returns `undefined` unless
 * `port` is a positive NUMBER, so idle-shutdown reaps the server under an open
 * window. That requirement is unconditional, which is why a good `url` does not
 * rescue a bad `port` here the way it does for `lockMayHaveServer` — dialing
 * once and holding the server alive are different needs, and only the second
 * one is what attaching commits us to. Both doors into attach ask this; the
 * break path asks the looser question and probes rather than assuming dead.
 * `createEphemeralWindow` polls too and is exempt by design, not by omission —
 * its lockDir is freshly synthesized under `os.tmpdir()`, so no foreign lock
 * can ever be there to refuse.
 */
function lockIsAttachable(lock: { port?: unknown }): boolean {
  return isDialablePort(lock.port);
}

/**
 * Base HTTP origin to dial for a lock holder — prefers the lock's `url`
 * (validated: http(s) + loopback hostname only, since the string comes off disk
 * and becomes renderer arguments), falling back to `port` for locks written by
 * binaries predating the field or whose `url` fails validation.
 *
 * Drift warning: mirrors `lockBaseUrl`/`dialableLockOrigin` in the server
 * package's `process-lock.ts`. This module is deliberately structurally
 * independent of that package (see `ServerLockMetadataLike`), so TypeScript
 * cannot catch divergence — both arms are pinned by
 * `tests/main/lock-api-origin-parity.test.ts`. One deliberate difference, also
 * pinned there: the canonical helper returns `null` when nothing is dialable;
 * this one returns `http://localhost:0`, which is safe only because it is a
 * string for argv and never a reachability claim.
 */
export function lockApiOrigin(lock: { port?: unknown; url?: unknown }): string {
  // Total by construction: callers that only need a string for argv always get
  // one. It is NOT a claim that the origin is reachable — the decision paths ask
  // `lockMayHaveServer` or `lockIsAttachable`, never this.
  return loopbackOriginFromUrl(lock.url) ?? `http://localhost:${lock.port}`;
}

/**
 * http(s) origin → ws(s) origin. The single scheme-swap primitive — every
 * desktop WS dial (lock-shaped or already-resolved `apiOrigin` string)
 * derives from this so `https` → `wss` can never silently diverge between
 * surfaces. Module-private: external callers go through `lockWsOrigin` /
 * `collabUrlFromApiOrigin`, which carry the validated-origin guarantee.
 */
function httpOriginToWsOrigin(origin: string): string {
  return origin.replace(/^http/, 'ws');
}

/**
 * WebSocket origin for a lock holder — `lockApiOrigin` with the ws(s) scheme,
 * so the v2 `url` preference and its port fallback carry into every WS dial.
 */
export function lockWsOrigin(lock: Pick<ServerLockMetadataLike, 'port' | 'url'>): string {
  return httpOriginToWsOrigin(lockApiOrigin(lock));
}

/**
 * `/collab` WebSocket endpoint for an already-resolved http(s) origin.
 * Consumers holding a `ProjectContext.apiOrigin` (the lock v2 `url` in attach
 * mode) call this instead of restating the scheme swap.
 */
export function collabUrlFromApiOrigin(apiOrigin: string): string {
  return `${httpOriginToWsOrigin(apiOrigin)}/collab`;
}

/** `/collab` WebSocket endpoint derived from the same origin as `lockApiOrigin`. */
export function lockCollabUrl(lock: { port?: unknown; url?: unknown }): string {
  return collabUrlFromApiOrigin(lockApiOrigin(lock));
}

interface ProjectContext {
  /**
   * User-facing absolute project path — as the caller supplied it after
   * `path.resolve`. Used for UI labels, recents list, and argv flags so
   * users continue to see the path they picked (e.g. a symlinked
   * workspace dir) rather than the realpath.
   */
  projectPath: string;
  /**
   * Canonical realpath — `realpathSync(projectPath)` if accessible, else
   * `projectPath` (fallback on ENOENT / EACCES). Used as the key into
   * `windowsByPath` so a deep-link URL carrying the canonical realpath
   * (emitted by `preview-url.ts:realpathSync(ctx.contentDir)`) matches a
   * window opened via a symlinked path. Without this, the producer/consumer
   * asymmetry causes `focusWindowForProject` to miss and spawn a duplicate.
   */
  canonicalKey: string;
  projectName: string;
  port: number;
  apiOrigin: string;
  window: BrowserWindowLike;
  /**
   * Utility we spawned for this window, or `null` in attach mode (the server
   * is owned by a sibling process — typically `ok start` run from a terminal
   * — and this window just connected to it).
   */
  utility: UtilityProcessLike | null;
  /**
   * Whether this window's process owns the utility/server lifecycle. Gates
   * shutdown IPC on window close and the post-exit liveness probe. When
   * `false`, closing the window leaves the sibling-owned server running.
   */
  ownsServer: boolean;
  /**
   * No-project ephemeral single-file session teardown state. Present only on
   * windows created by `createEphemeralWindow`. Unlike a normal detached
   * server (which survives window-close by design and is tracked in
   * `spawnedDetachedPids` keyed by project root), an ephemeral server MUST die
   * on window-close — so its teardown state lives here, the single source of
   * truth: the `'closed'` handler terminates `pid` (polling `lockDir` for
   * release) then removes `projectDir`. Deliberately NOT in `spawnedDetachedPids`
   * — that map's `stopAllOwnedServers` derives `lockDir` from the map key
   * (= project root), but the ephemeral window is keyed by the canonical FILE
   * path, so `getLocalDir(key)` would resolve the wrong lock.
   */
  ephemeral?: {
    /** Throwaway temp project root (`os.tmpdir()/ok-ephemeral-*`) to remove on close. */
    projectDir: string;
    /** Detached server pid to terminate on close. */
    pid: number;
    /** `<projectDir>/.ok/local` — where the server's lock lives (poll target for the SIGTERM grace). */
    lockDir: string;
  };
}

/**
 * The `createEphemeralWindow` inputs retained per-window so a later "Restart
 * server" can replay the exact open — even for a dead window a re-open has
 * already orphaned from `windowsByPath`. See `ephemeralWindowIdentity`.
 */
export interface EphemeralOpenIdentity {
  canonicalFilePath: string;
  contentDir: string;
  docName: string;
}

interface CreateProjectWindowOpts {
  projectPath: string;
  /**
   * Optional kind-discriminated deep-link target to deliver to the renderer
   * after window mount. Used by the `openknowledge://` URL scheme handler +
   * the share-receive flow so the send is registered BEFORE `await loadURL`
   * and fires via `webContents.once('dom-ready', ...)`. Delivery ordering is
   * load-bearing: registering after loadURL resolves silently misses
   * dom-ready (which fires before did-finish-load). Pairs with the
   * renderer's `ok:deep-link` subscriber in `main.tsx`. Structurally matches
   * the bridge contract's `pendingDeepLinkTarget` so the index.ts seam
   * passes it straight through without decomposing into separate fields.
   */
  pendingDeepLinkTarget?: {
    kind: 'doc' | 'folder';
    path: string;
    repositoryPath?: string;
    contentRootDepth?: number;
  };
  /**
   * Optional share branch carried alongside `pendingDeepLinkTarget`. Threaded
   * into the same `dom-ready` deep-link IPC so the renderer's deep-link
   * listener can surface it. Null / undefined / absent are treated
   * identically — back-compat with non-share deep-link sources (the
   * `openknowledge://open?project=&doc=` MCP path has no branch).
   */
  pendingBranch?: string | null;
  /**
   * `true` iff the dispatcher's candidate-selection evaluated more than
   * one candidate. Carried through to the renderer's `ok:deep-link`
   * payload so `installDeepLinkListener` can suppress the "Opened
   * on branch X" toast for single-clone receivers and surface it
   * for multi-worktree receivers. Treat `undefined` / `false`
   * identically.
   */
  pendingMultiCandidate?: boolean;
  /**
   * `true` iff main's target-existence gate found the share's target absent
   * on the candidate's checked-out branch. Carried into the renderer's
   * `ok:deep-link` payload so `installDeepLinkListener` toasts "not on this
   * branch yet" in-context instead of opening a blank editor. Treat
   * `undefined` / `false` identically.
   */
  pendingTargetMissing?: boolean;
  /**
   * Project-scoped branch-switch payload (`ok:share:received` with
   * `kind: 'project-branch-switch'`). Delivered on the editor renderer's
   * `dom-ready` after `createProjectWindow` resolves, mirroring the
   * `pendingDeepLinkTarget` gate so the cold-start payload is not dropped.
   * When the project is already open, the share-deps wrapper in `index.ts`
   * sends directly via `sendShareDeepLink` and does not pass this field.
   */
  pendingShareBranchSwitch?: ShareDeepLinkBranchSwitchPayload;
  /**
   * True when main has already run `ensureProjectGit(projectPath)` before
   * spawning the utility (the consent-dialog silent path / silent fresh
   * path). The utility short-circuits its own `ensureProjectGit` call —
   * idempotent re-run is safe via the hardened repair, but this flag
   * avoids the redundant fs probe. Default false.
   */
  didEnsureGit?: boolean;
  /**
   * Version stamp of the consent contract carried alongside this open. Lets
   * us bump the IPC payload shape later without re-wiring every caller.
   * Default 1.
   */
  consentVersion?: number;
  /**
   * Bundled CLI invocation to thread to the utility's API server so that
   * `/api/local-op/*` (auth/login, clone, etc.) can spawn the CLI without
   * relying on `open-knowledge` being on PATH. Caller (main) supplies this
   * derived from `app.isPackaged`, mirroring the IPC-side
   * `LocalOpDeps.resolveCliArgs` so HTTP and IPC paths resolve consistently.
   * Optional: when omitted, the utility falls back to `createApiExtension`'s
   * default `['open-knowledge']`, which is correct for dev / Vite plugin
   * contexts where PATH resolution succeeds.
   */
  localOpCliArgs?: string[];
  /**
   * Set by the server-restart flow when this window is the freshly-recreated
   * replacement after a successful `restartServer`. Threads to the attach
   * factory, which fires `ok:server-restarted` on `did-finish-load` so the
   * renderer confirms the server now matches the app.
   */
  pendingServerRestartedToast?: boolean;
  /**
   * `true` when this open is a first-run create-new flow (blank or starter-pack
   * seed), derived by the caller from the `create-new` entry point. Forwarded to
   * the renderer as `--ok-fresh-create=1`; the onboarding card keys off it (see
   * `evaluateFreshProject` for why). Default false — a plain boolean keeps the
   * manager decoupled from `EntryPoint` semantics.
   */
  freshlyCreated?: boolean;
}

/** Test-injectable side-effect surface (Electron + node:fs primitives). */
export interface WindowManagerDeps {
  /** `electron.BrowserWindow` constructor (subsetted). */
  createWindow(opts: {
    additionalArguments: string[];
    /**
     * Window title — the project name. Passed through to Electron's
     * `new BrowserWindow({ title })` so users can distinguish open windows
     * at the OS level (Dock, Mission Control, ⌘-` switcher, Cmd+Tab).
     * Main-process also hooks `page-title-updated` to prevent the renderer's
     * `<title>OpenKnowledge</title>` from overwriting this after load.
     */
    title: string;
    /**
     * Resolved user-facing project path (`ProjectContext.projectPath`) —
     * the same string that keys `recentProjects` / `projectSessions` and
     * that `getOpenProjectPaths()` returns, so the production seam keys
     * window-bounds memory and focus-recency tracking consistently with
     * both the relaunch-restore snapshot and `removeRecentProject` cleanup
     * (which deletes by this exact string — a divergent key would leak the
     * bounds entry). Present only for project windows (spawn + attach);
     * ephemeral single-file windows omit it and keep cascade placement (their
     * "projectPath" is the file's parent dir, never a project, so bounds memory
     * and `lastOpenedProject` must not key off it). Ephemeral windows instead
     * pass `focusKey`.
     */
    projectPath?: string;
    /**
     * Focus-recency key for an ephemeral single-file window — the canonical
     * file path. Wired so a loose-file window joins the restore focus ordering
     * (and the post-restore raise) WITHOUT writing `lastOpenedProject`, which
     * stays project-only (keyed by `projectPath`). Absent for project windows.
     */
    focusKey?: string;
    /** Other webPreferences / window opts the manager wants to set. */
  }): BrowserWindowLike;
  /**
   * `electron.utilityProcess.fork(entry, args, opts)`. Preserved for the
   * Electron dev runtime where the renderer's HMR / log-capture ergonomics
   * outweigh "one code path." Production code paths use
   * `spawnDetachedServer` instead so the server outlives the Electron
   * parent (window-close and app-quit no longer affect the server).
   */
  forkUtility(
    entry: string,
    args: string[],
    opts: { windowLifecycleBound?: boolean },
  ): UtilityProcessLike;
  /** Path to the bundled utility-entry script (electron-vite output). */
  utilityEntryPath: string;
  /**
   * Production spawn primitive: detach the OpenKnowledge server from
   * Electron's process tree by spawning `dist/cli.mjs start` as a
   * fully-detached `child_process.spawn` of `process.execPath` under
   * `ELECTRON_RUN_AS_NODE=1`. The server then survives Electron parent
   * exit (window-close OR app-quit) — every desktop project window
   * effectively becomes attach-mode after this single bootstrap call.
   *
   * When wired, `createProjectWindow` takes the detached path; when omitted,
   * it falls back to `forkUtility` (the Electron-dev path). Production
   * wiring in `index.ts` provides this; the test harness can omit it to
   * keep exercising the utility-fork path or wire a mock to exercise the
   * detached path.
   *
   * Returns the spawned pid only — readiness is observed via
   * `<contentDir>/.ok/local/server.lock` appearing with a valid `port` and
   * `kind` (the CLI writes the lock atomically once `httpServer.listen`
   * resolves). `WindowManager.pollServerLock` does the post-spawn wait.
   */
  spawnDetachedServer?(opts: {
    contentDir: string;
    reactShellDistDir: string;
    /**
     * No-project ephemeral single-file mode (`ok <file>`). Absolute path of the
     * one markdown file to open. When set, the child boots the slim single-file
     * shape (`start --single-file <singleFile> --project-dir <projectDir>`): git
     * + MCP off, content scoped to the file. `projectDir` (the throwaway temp
     * root) then anchors the spawn cwd + the `server.lock` the parent polls,
     * while `contentDir` stays the file's real parent. Absent for normal
     * project opens.
     */
    singleFile?: string;
    /** Throwaway temp project root for the ephemeral spawn (lock + cwd anchor). */
    projectDir?: string;
  }): Promise<{
    pid: number;
    /**
     * How the child died, or `null` while it is still running.
     *
     * The parent has no other channel for a reason. `stdio` captures the
     * child's output to `SPAWN_ERROR_LOG`, but a child can exit having written
     * nothing there — a failure reported on stdout, or a signal death — which
     * leaves the operator with a bare deadline and no way to tell a fast crash
     * from a slow start. Exit code + signal are the two facts always available
     * to the parent, so they must not be dropped.
     *
     * Optional: callers that spawn without observing exit (and every existing
     * test stub) stay valid, and the poll degrades to the deadline.
     */
    readExit?: () => { code: number | null; signal: string | null } | null;
  }>;
  /**
   * Create the throwaway `projectDir` for an ephemeral single-file session
   * (`os.tmpdir()/ok-ephemeral-*` carrying a synthesized `.ok/config.yml`).
   * Production wires `createEphemeralProjectDir` from
   * `@inkeep/open-knowledge-server`; tests inject a stub that records the call
   * (so the dedup-before-create invariant — one temp dir per distinct file — is
   * directly assertable). Only consulted by `createEphemeralWindow`; absent on
   * the project-open path.
   */
  createEphemeralProjectDir?(contentDir: string): string;
  /**
   * Remove a directory tree (the ephemeral temp projectDir) on session
   * teardown. Production wires `fs.rm(dir, { recursive: true, force: true })`;
   * tests inject a stub that records removals so the `'closed'` → terminate +
   * rm sequence is assertable. Sibling of `createEphemeralProjectDir`.
   */
  removeDir?(dir: string): Promise<void>;
  /**
   * Upper bound (ms) on waiting for a detached server that shows no sign of
   * life. Default 15s. This bounds the "did the spawn get anywhere at all"
   * question only — a child observed to be ALIVE at this deadline is not
   * killed, it graduates to `spawnLockProgressDeadlineMs` below.
   *
   * `bootServer` does O(project-state) work (shadow-repo import, file-watcher
   * walk, index hydration) BEFORE `httpServer.listen` resolves, and only then
   * flips the lock's port off its `0` sentinel. On a large working copy that
   * phase alone can outlast any fixed wall-clock figure, so treating this
   * deadline as a kill deadline makes such projects permanently unopenable.
   * Tests pass small values.
   */
  spawnLockPollDeadlineMs?: number;
  /**
   * Hard cap (ms) on the extended wait a LIVE child earns once
   * `spawnLockPollDeadlineMs` elapses. Defaults to
   * `spawnLockPollDeadlineMs * SPAWN_WAIT_EXTENSION_FACTOR`.
   *
   * Liveness is the only progress signal the parent has during the pre-listen
   * phase — the child emits no events there — so the wait is bounded by this
   * cap rather than continued indefinitely: a genuinely wedged (but alive)
   * server still has to surface as a failure eventually. Must be >= the
   * startup deadline; a smaller value is clamped up to it.
   */
  spawnLockProgressDeadlineMs?: number;
  /**
   * Override for `DEFAULT_SIGTERM_GRACE_MS` (10 s) — how long
   * `stopAllOwnedServers` waits for a detached pid's lock to release
   * after SIGTERM before escalating to SIGKILL. Tests pass a small value
   * (1-10 ms) so the escalation path runs in unit-test time without
   * making the actual wall-clock 10 s wait.
   */
  sigtermGraceMs?: number;
  /**
   * Open a `/collab/keepalive` WebSocket against the project's server. Used
   * by the desktop main process to register itself as an active WS client
   * so the server's idle-shutdown counter does NOT fire while a project
   * window is open — even if every MCP client transiently disconnects
   *
   * Presence-invisibility: the wired callback MUST NOT pass
   * `displayName` / `clientName` / `colorSeed` to `startKeepalive`. The
   * desktop "IS" the user; it's redundant to render itself as a peer in
   * the agent-presence bar.
   *
   * Production wiring uses `startKeepalive` from `@inkeep/open-knowledge-
   * core` with `resolveWsUrl` that re-reads `<lockDir>/server.lock` on
   * each connect attempt (so a server restart on a different port is
   * picked up transparently). Tests inject a stub that records open/close
   * lifecycle without opening a real socket.
   *
   * Optional: when omitted, the WindowManager skips keepalive entirely
   * (back-compat with existing tests that don't exercise the keepalive
   * lifecycle).
   */
  createKeepalive?(opts: { lockDir: string }): KeepaliveHandle;
  /** Path to the bundled renderer index.html (extraResources `app/index.html` or dev shell). */
  rendererEntryPath: string;
  /** electron-vite dev-server URL (`process.env.ELECTRON_RENDERER_URL`). When present,
   *  main uses `loadURL` for HMR; otherwise falls back to `loadFile(rendererEntryPath)`. */
  rendererDevUrl?: string | null;
  /**
   * App version (`app.getVersion()`), threaded through to the renderer's preload
   * via `--ok-app-version=<v>` in `additionalArguments`. Without this, the preload
   * defaults `bridge.appVersion` to `'0.0.0'` and the Settings dialog renders
   * `v0.0.0`. Mirrors `NavigatorDeps.appVersion`.
   */
  appVersion: string;
  /**
   * The desktop's own `(protocolVersion, runtimeVersion)` — supplied here
   * rather than imported so this module stays runtime-independent of the
   * server package (same rationale as `ServerLockMetadataLike` being
   * structural). Used by the attach path to classify version drift against
   * the lock the window connected to. `index.ts` wires these from
   * `PROTOCOL_VERSION` / `RUNTIME_VERSION`. Optional: when either is omitted
   * (test harnesses not exercising drift), the attach path skips
   * classification entirely — no notification, never a false positive.
   */
  selfProtocolVersion?: number;
  selfRuntimeVersion?: string;
  /**
   * Dev-only escape hatch: when true, the attach path terminates a *foreign*
   * server (one this desktop session did not spawn) it would otherwise attach
   * to, then spawns a fresh own-build server in its place — so a dev running
   * `electron-vite dev` against a project that still has a server from a prior
   * packaged-app run (or a CLI / another instance) actually exercises their
   * working-tree server + core code instead of silently attaching to the stale
   * build. The reclaim terminates + respawns silently — the routine per-rebuild
   * restart is not worth a notice.
   *
   * Wired from `!app.isPackaged` in `index.ts`; never set in packaged builds
   * (a packaged user attaching to a live server is the intended shared-server
   * behavior, not drift to reclaim). Omitted/false → the attach path behaves
   * exactly as before.
   */
  reclaimForeignServerInDev?: boolean;
  /**
   * Packaged-path upgrade reconcile: `true` iff THIS launch is the first run
   * after the app's version changed (an auto-update installed a new build).
   * When set, the attach path treats a version-mismatched server it would
   * otherwise attach to as a pre-upgrade survivor — the pre-install teardown
   * (`stopAllOwnedServers`) only reaps servers this desktop spawned, so a
   * CLI-spawned or teardown-timed-out server outlives the swap — and
   * terminates it, spawning the app's own version in its place rather than
   * attaching to the stale build and prompting the user to restart. Any drift
   * direction qualifies: the trigger is "we just upgraded", not the version
   * ordering.
   *
   * A stable per-session snapshot, NOT a live read: `index.ts` captures it at
   * bootstrap from `appState.lastSeenVersion` BEFORE the auto-updater advances
   * that marker, so it stays true for every project opened this run. A live
   * read would flip false once the updater advances mid-session and miss a
   * second project opened later. Omitted (test harnesses, dev) → the attach
   * path never auto-terminates on version mismatch.
   */
  isFirstLaunchAfterUpgrade?(): boolean;
  /** Schedule a one-shot timer (test injection for the post-exit liveness probe). */
  setTimeout(cb: () => void, ms: number): unknown;
  /**
   * Schedule a repeating timer for the ephemeral single-file session's
   * server-liveness watch. Kept SEPARATE from `setTimeout` (which
   * several tests inject as an immediate-firing stub to advance the bounded
   * spawn-lock poll) because the watch is an UNBOUNDED periodic poll — reusing
   * an immediate `setTimeout` would recurse forever. Production wires
   * `setInterval`; when unwired (test harnesses that don't exercise the watch),
   * the exit-watch is simply not armed and the probe-on-dedup backstop still
   * repairs the reported symptom. Paired with `clearInterval` (all-or-nothing).
   */
  setInterval?(cb: () => void, ms: number): unknown;
  /** Cancel a timer started by `setInterval`. Wired iff `setInterval` is. */
  clearInterval?(handle: unknown): void;
  /** `process.kill(pid, signal)` — used in the post-exit liveness probe. */
  killProbe(pid: number, signal: number | NodeJS.Signals): void;
  /**
   * Dual-signal window-show coordinator. The factory registers each new
   * BrowserWindow before `loadURL` so `ready-to-show` AND `ok:theme:applied`
   * must both arrive before the OS-level window appears. Replaces the prior
   * single-signal `once('ready-to-show')` + bare 5 s timeout that allowed
   * cold-launch chrome mismatch under `transparent: true` + vibrancy.
   * Tests inject a stub registry; production wires the singleton from
   * `show-gate.ts`.
   */
  showGate: ShowGateRegistry;
  /** Optional hook to run runClean before forking the utility. */
  runClean?(opts: { lockDir: string }): Promise<void>;
  /**
   * Resolve a path to its canonical realpath (dereference symlinks). Only
   * used for `windowsByPath` keying — a deep-link URL emitted by MCP's
   * `preview-url.ts` carries `realpathSync(contentDir)` as its `project`
   * query param. Without matching canonicalization here, a user who opened
   * a project via a symlinked path would see the deep-link miss
   * `focusWindowForProject` and spawn a duplicate window.
   *
   * Production: `fs.realpathSync`. Tests inject to simulate symlinks
   * without touching the filesystem. Throws (ENOENT, EACCES) fall back to
   * the input path so the pre-canonicalization behavior is preserved on
   * unreadable paths.
   */
  realpathSync?(p: string): string;
  /**
   * App-level foreground activation, wired from `electron.app.focus({ steal:
   * true })` in `index.ts`. The macOS-only primitive that pulls a backgrounded
   * app to the front — `BrowserWindow.focus()` only reorders within the app
   * (electron/electron#19920). Paired with `win.moveTop()` in `bringToFront`.
   * Omitted in tests (and a no-op off macOS) so the class stays Electron-free.
   */
  activateApp?(): void;
  /**
   * Read the OpenKnowledge server lock at `<lockDir>/server.lock`. Returns
   * null if absent or corrupt. Production: `readServerLock` from
   * `@inkeep/open-knowledge-server`. Tests inject a stub.
   *
   * When omitted (back-compat with existing tests), the attach branch is
   * effectively disabled and every call spawns a fresh utility.
   */
  readServerLock?(lockDir: string): ServerLockMetadataLike | null;
  /**
   * Delete a project's `server.lock` outright, breaking a holder's claim
   * without its cooperation. Deliberately NOT the server's `releaseServerLock`,
   * which is refcounted for the OWNING process and no-ops for anyone else.
   *
   * Reached from the two recovery entry states — `restartAttachedServer` (from an
   * open window) and `forceStopConflictingServer` (from the failed-open dialog),
   * once a holder has proven BOTH unkillable (EPERM) and not serving. Both
   * halves are load-bearing: a live server's lock must never be broken, or two
   * servers end up bound to one project.
   *
   * `expected` is the holder the caller decided about, and the implementation
   * MUST re-read the file and unlink only if it still names that pid. The
   * decision takes hundreds of milliseconds (a health probe), and the holder
   * can exit and a fresh server acquire the lock inside that window — an
   * unguarded unlink would delete the newcomer's valid claim on the strength of
   * a verdict about its predecessor. `process-lock.ts`'s `registerExitUnlink`
   * is the same read-compare-unlink shape for the same reason.
   *
   * Returns whether THIS call removed the lock, so the caller logs what happened
   * rather than what it intended.
   *
   * Optional only for back-compat with tests that never reach the recovery.
   * Whether to break a lock is a fact about the HOLDER, so leaving this unwired
   * does not change that verdict — it just makes the break a no-op, and the
   * recreate that follows then fails loudly on the stale lock rather than
   * silently wiring a window to it.
   */
  removeServerLock?(lockDir: string, expected: { pid: number }): boolean;
  /**
   * Check whether a pid is alive on this host (EPERM counts as alive per the
   * `process.kill(pid, 0)` semantics in `isProcessAlive`). Production:
   * `isProcessAlive` from `@inkeep/open-knowledge-server`.
   */
  isProcessAlive?(pid: number): boolean;
  /**
   * Current host — `os.hostname()` in production. Used to compare against
   * `server.lock`'s `hostname` field so we only attach on same-host locks;
   * foreign-host locks fall through to spawn-mode.
   */
  hostname?(): string;
  /**
   * Probe `ws://localhost:<port>/collab/...` for a healthy WebSocket
   * upgrade. Resolves `true` on the `open` event, `false` on `close` or
   * timeout. Used as the final attach gate so a server claiming
   * `capabilities: ["ws"]` but actually hanging WS upgrades (the live
   * symptom that motivated this validation) is caught before any document
   * load is attempted.
   *
   * Production wiring uses the platform `WebSocket`. Tests inject a stub
   * that resolves true/false synchronously (no real socket). When omitted,
   * the probe is skipped — back-compat path for tests that don't care
   * about this gate.
   */
  probeWsUpgrade?(url: string, timeoutMs: number): Promise<boolean>;
  /**
   * Upper bound (ms) on waiting for the utility to post `ready` or `error`
   * after `init`. Default 15s, narrow enough that a silently-hung utility
   * surfaces within a debuggable window. Test injections typically pass a
   * much smaller value.
   *
   * Unlike the detached-spawn wait, this one is a flat reject with no
   * liveness graduation — and 15s is NOT a safe margin for `bootServer` on a
   * large project: that pre-`listen` phase scales with project state and has
   * no upper bound, which is precisely why the detached path grew a second
   * tier. This path stays flat because it is the dev/electron-vite runtime
   * only (production wires `spawnDetachedServer`), so a slow reject costs a
   * developer a retry rather than making a project unopenable.
   */
  utilityInitTimeoutMs?: number;
  /**
   * Notified after a server restart has successfully recreated a project's
   * window on the fresh server, before the old window closes.
   *
   * Exists for popped-out note windows. They live outside `windowsByPath`, so
   * the recreate above does not reach them, and their attach argv is a frozen
   * snapshot — a note window left behind would hold a collab URL pointing at
   * the terminated server and could never reconnect, even though the project is
   * healthy again. The window manager stays unaware of the note registry (as it
   * is of the terminal registry); the consumer wires the recreate.
   */
  onProjectServerRestarted?(args: {
    readonly projectPath: string;
    /** The FRESH server's origin, so the recreate attaches to the new port. */
    readonly apiOrigin: string;
  }): void;
  /** Logger. */
  log?: {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
  };
  /**
   * Post-init persistent message listener, installed once after the
   * init-phase `ready` handshake settles — routes messages like
   * `debug-keyring-smoke-result` without competing with the init-phase
   * listener. Consumer narrows by `msg.type`.
   */
  onUtilityMessage?(msg: unknown): void;
  /**
   * Notified whenever a utility process emits `exit` (normal shutdown OR
   * crash). The debug-ipc relay uses this to cancel any pending
   * `debug-keyring-smoke` requests that were posted to this utility —
   * otherwise those entries sit in the pending Map until their per-request
   * timeout fires. Called with the same `utility` reference that was passed
   * to `onUtilityMessage`, so the consumer can identity-match.
   */
  onUtilityExit?(utility: UtilityProcessLike): void;
  /**
   * Record why the server just exited to `<lockDir>/last-server-exit.json`, so
   * a later bug-report bundle can tell an unexpected death from a managed
   * shutdown. No-op when omitted (tests, web). See `server-exit-record.ts`.
   *
   * Narrowed from the recorder's own payload rather than restated, so the two
   * cannot drift: the `utilityProcess` exit event this is called from carries
   * no signal and does not name the observing host, so `index.ts`'s adapter
   * supplies both. The record's `signal` is only ever filled by the packaged
   * detached-spawn observer.
   */
  recordServerExit?(info: Pick<ServerExitInfo, 'lockDir' | 'pid' | 'code'>): void;
  /**
   * Startup-instrumentation hooks (desktop launch waterfall). All optional and
   * no-op when omitted (tests, web). Wired by `index.ts` only for the FIRST
   * project window opened at launch; later windows leave them unset so the
   * waterfall isn't re-stamped. Kept as plain callbacks so the WindowManager
   * stays decoupled from the waterfall aggregator + OTel trace modules.
   */
  startup?: {
    /** W3C traceparent of main's `ok.app-startup` root, injected as `--ok-startup-traceparent=`. */
    traceparent?: string;
    /**
     * Mark the moment the server lock became ready. `startedAt` is the server's
     * lock wall-clock (omitted on the dev fork path); `apiOrigin` lets main
     * fetch `/api/server-info` once for the server boot timings.
     */
    markServerLockReady?(info?: { startedAt?: string; apiOrigin?: string }): void;
    /** Mark the moment the BrowserWindow was created. */
    markWindowCreated?(): void;
    /** Mark the moment `loadURL`/`loadFile` resolved. */
    markLoadUrlResolved?(): void;
  };
  /**
   * External-link safety-net delegates, grouped so the net is all-or-nothing.
   * `attachSafetyNet` needs BOTH to function, so a partial wiring (one delegate
   * but not the other) is unrepresentable rather than silently producing
   * net-less windows — the #617 failure class must not resurface at the wiring
   * layer. Absent in the unit harnesses that don't exercise the net; present in
   * production (wired once in `index.ts`) and the factory-net tests.
   */
  safetyNet?: {
    /**
     * OS-browser delegate. Window-independent — `index.ts` wires
     * `handleShellOpenExternal({ openExternal: url => shell.openExternal(url) })`.
     */
    openExternal: (url: string) => Promise<void>;
    /**
     * Project-scoped asset opener for the in-app-asset branch. Parameterized by
     * `projectPath` because each window's containment root differs — `index.ts`
     * wires `(projectPath, relPath) => openAssetSafely({ projectPath, platform, openPath }, relPath)`.
     */
    openAsset: (projectPath: string, relPath: string) => Promise<AssetOpenResult>;
  };
}

/**
 * Send a best-effort SIGTERM to each `[projectPath, pid]` detached-server entry.
 * Pure over its injected `killProbe` + `log` so the `before-quit-for-update`
 * teardown loop is unit-testable without constructing a `WindowManager`.
 *
 * ESRCH (the pid already exited) is treated as success-by-absence and not
 * counted; any other signal failure is logged but never thrown — the caller is
 * mid-quit and must not be blocked by a kill error. Returns the number of pids
 * that actually received the signal (live servers), for diagnostics + tests.
 */
export function signalDetachedServerStop(
  entries: ReadonlyArray<readonly [string, number]>,
  killProbe: (pid: number, signal: number | NodeJS.Signals) => void,
  log?: { warn(obj: object, msg: string): void },
): number {
  let signalled = 0;
  for (const [projectPath, pid] of entries) {
    try {
      killProbe(pid, 'SIGTERM');
      signalled++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') continue;
      log?.warn(
        {
          event: 'update-install-server-stop-failed',
          err,
          code,
          pid,
          projectPath,
        },
        'SIGTERM failed during before-quit-for-update teardown',
      );
    }
  }
  return signalled;
}

/**
 * SIGKILL every owned utility-fork (dev-path `utilityProcess.fork` server) in
 * `contexts`. Synchronous + injected-`log` pure, shared by both owned-server
 * teardown surfaces (`stopAllOwnedServers` and the await-free
 * `signalStopAllOwnedServers`) so the predicate + error handling can't drift
 * between them. A kill failure is logged, never thrown — neither caller can be
 * blocked by a signal error mid-teardown.
 */
export function signalStopOwnedUtilityForks(
  contexts: Iterable<Pick<ProjectContext, 'ownsServer' | 'utility' | 'projectPath'>>,
  log?: { warn(obj: object, msg: string): void },
): void {
  for (const ctx of contexts) {
    if (!ctx.ownsServer || !ctx.utility) continue;
    try {
      ctx.utility.kill('SIGKILL');
    } catch (err) {
      log?.warn(
        { err, projectPath: ctx.projectPath },
        'utility SIGKILL failed during owned-server teardown',
      );
    }
  }
}

export class WindowManager {
  /**
   * canonicalKey → ProjectContext. Key is `realpathSync(resolve(projectPath))`
   * with an ENOENT fallback to `resolve(projectPath)`, so a deep-link URL
   * carrying the canonical realpath (emitted by `preview-url.ts`) matches
   * a window opened via a symlinked path. See `canonicalizeKey` + the
   * `canonicalKey` field on `ProjectContext`.
   */
  private readonly windowsByPath = new Map<string, ProjectContext>();

  /**
   * BrowserWindow → the original `createEphemeralWindow` inputs, for every
   * ephemeral single-file window, cleared only when that window actually closes.
   * Distinct from `windowsByPath`: a re-open after the server died replaces the
   * slot with the fresh window, orphaning the still-open dead window from that
   * map — but a "Restart server" click can still come from the dead window, and
   * it must route to the ephemeral respawn (not the directory-keyed project
   * restart, which fails with a toast loop). Also the source for
   * `retireStaleWindowsForFile` (find every window for a file to converge on one).
   */
  private readonly ephemeralWindowIdentity = new Map<BrowserWindowLike, EphemeralOpenIdentity>();

  /**
   * BrowserWindow → its ProjectContext for two of the spans in which no
   * authoritative `windowsByPath` entry answers for a window the user can see
   * and act on. Other such spans exist and do not use this map; the ones worth
   * knowing about are named below. Neither list is exhaustive. Read only
   * through `getContextForBrowserWindow`.
   *
   * The two spans this map covers, both seconds long:
   *
   *   - A newly created window. Its `windowsByPath` entry lands only AFTER
   *     `await loadFile` resolves, whereas the window — and the application
   *     menu acting on it — exists from the moment `createWindow` returns, and
   *     every field of the context is known before that call.
   *   - A window mid-`restartAttachedServer`. That path deliberately detaches
   *     the originating window from `windowsByPath` so the recreate spawns a
   *     new window instead of focusing the old one, and keeps the old one open
   *     and on screen until the replacement exists.
   *
   * `createEphemeralWindow`'s stale-entry sweep does NOT publish, and must not.
   * It drops the entry for a superseded single-file window it deliberately
   * leaves open, and that window is a tombstone rather than one awaiting a
   * replacement: its server is dead with nothing coming, its temp dir has been
   * reaped, and the file now belongs to the fresh window the user just asked
   * for. There is also no bounded span to release on — the sweep invalidates
   * the ownership guard in that window's own `'closed'` handler, so a publish
   * made there would never be released at all.
   *
   * The utility-fork `on('exit')` handler also drops the entry under a window
   * that stays open, on the dev-only spawn path. It does not publish today, and
   * this docblock does not rule on whether it should: the ephemeral exit-watch
   * declines that very drop, on the grounds that the entry is what keeps a
   * still-open window in the session-restore set.
   *
   * In the two published spans, this class owned a project window it would not
   * admit to owning: anything asking "which project is this window's?" got
   * `undefined`. The user-visible cost was Terminal → New Terminal Window,
   * where `resolveTerminalWindowProject` saw no editor context and opened a
   * project-less HOME-cwd window with an empty collab URL, silently.
   *
   * Deliberately keyed by window rather than project: this answers the
   * window→project question only. Widening `windowsByPath` instead would
   * change its meaning — a completed, dedupable, restorable window — to admit
   * one that may still fail to load. That reason covers the create span, not
   * the restart span, whose window was all three of those things a moment
   * earlier. So the restart span leaves a known residual on the reverse
   * direction: `getOpenWindows`, `getOpenProjectPaths` and `getWindowFor` read
   * `windowsByPath` alone, and a quit landing inside a restart therefore writes
   * a restore snapshot with that project missing. Closing that needs the two
   * spans told apart, which is a separate change.
   */
  private readonly loadingContextByWindow = new Map<BrowserWindowLike, ProjectContext>();

  /**
   * canonicalKey → pid of the detached server THIS desktop process spawned
   * during its lifetime. Survives window closes within the same desktop run
   * (the server outlives the window in detached mode); cleared when the
   * desktop quits. Consumed by `stopAllOwnedServers` to identify which
   * detached pids to SIGTERM before `quitAndInstall` — desktops never
   * touch detached servers spawned by MCP or by a prior desktop session.
   */
  private readonly spawnedDetachedPids = new Map<string, number>();

  /**
   * canonicalKey → in-flight `createEphemeralWindow` promise. Closes the dedup
   * TOCTOU: the authoritative `windowsByPath.set` lands only after the
   * seconds-long detached spawn + server-lock poll + renderer load, so a second
   * `ok <samefile>` arriving during that window would otherwise miss the
   * `windowsByPath` dedup and spawn a SECOND server on the same inode —
   * dual-writer (lost edits, since each ephemeral server has its own temp
   * projectDir so the `server.lock` never collides) plus a permanent orphan
   * (the loser is absent from `windowsByPath`, so neither its `'closed'`
   * handler nor `stopAllOwnedServers` reaps it). The reservation is registered
   * synchronously before the first await; a concurrent caller awaits it and
   * focuses the resulting window. Cleared inside the work body so it is gone by
   * the time any awaiter resumes (no resume-ordering hazard).
   */
  private readonly ephemeralPendingByPath = new Map<string, Promise<ProjectContext>>();

  /**
   * canonicalKey → in-flight `createProjectWindow` promise. The project analog
   * of `ephemeralPendingByPath`: `createProjectWindow`'s existing dedup only
   * matches a COMPLETED window in `windowsByPath`, but that entry lands only
   * after the seconds-long discover + spawn + renderer load. Two concurrent
   * opens of the same project (session restore re-deriving two loose files into
   * one project, or a restore racing a deep-link) would both miss the completed-
   * window dedup and spawn a duplicate window + second server. Registered
   * synchronously before the first await; a concurrent caller awaits it and
   * focuses the resulting window. Cleared in the work body's `finally`.
   */
  private readonly projectPendingByPath = new Map<string, Promise<ProjectContext>>();

  /**
   * canonicalKey → keepalive WS handle for the open project window. Opened
   * by `attachToExistingServer` and closed by the window's `closed` handler
   * — so the WS bracket exactly matches "a project window is open." The
   * server's idle-shutdown counter sees this WS as a `/collab*` upgrade
   * (per `idle-shutdown.ts`), keeping the server alive while the desktop
   * is interested in the project.
   */
  private readonly keepalives = new Map<string, KeepaliveHandle>();

  constructor(private readonly deps: WindowManagerDeps) {}

  /**
   * Canonicalize a project path to its realpath. Dereferences symlinks so the
   * map key matches what `preview-url.ts` emits in `openknowledge://` URLs.
   * Falls back to `resolve(projectPath)` on ENOENT / EACCES so unreadable
   * paths don't throw past the call site.
   */
  private canonicalizeKey(projectPath: string): string {
    const absolute = resolve(projectPath);
    const rp = this.deps.realpathSync ?? realpathSync;
    try {
      return rp(absolute);
    } catch {
      return absolute;
    }
  }

  /**
   * Read-only snapshot for tests + the dialog handler. Canonicalizes the
   * input via `canonicalizeKey` (realpath + resolve) — matches the key shape
   * used when `createProjectWindow` stores entries in `windowsByPath`.
   * Without this, callers that pass a non-resolved or symlinked path get
   * `undefined` even when the window actually exists. Symmetric with
   * `focusWindowForProject`.
   */
  getWindowFor(projectPath: string): ProjectContext | undefined {
    return this.windowsByPath.get(this.canonicalizeKey(projectPath));
  }

  /**
   * Narrow focus-only lookup used by the `openknowledge://` URL scheme
   * router. If a window already owns `projectPath`, surface it (restore if
   * minimized, show if hidden) + return it for the caller to push a deep-
   * link event to. Returns `null` when no window matches.
   *
   * Find-or-nothing. Callers decide whether to spawn a new window when no
   * match exists — every project pick spawns a new window; only the
   * same-project warm deep-link case reuses.
   *
   * Path matching uses `canonicalizeKey` (realpath + resolve), the same
   * canonicalization `createProjectWindow` applies — so a deep-link URL
   * carrying a realpath matches a window opened via a symlinked path.
   */
  focusWindowForProject(
    projectPath: string,
    opts?: { activate?: boolean },
  ): BrowserWindowLike | null {
    const ctx = this.windowsByPath.get(this.canonicalizeKey(projectPath));
    if (!ctx) return null;
    // Same destroyed-window gate every other `bringToFront` caller applies. A
    // map entry outlives its native window by the gap between `closed` firing
    // and the utility `exit` that clears the entry, and calling into a
    // destroyed BrowserWindow throws. Reporting it as "no window" sends deep
    // links down their cold path, which is the right answer for one that is
    // gone.
    if (ctx.window.isDestroyed?.() === true) return null;
    this.bringToFront(ctx.window, opts);
    return ctx.window;
  }

  /**
   * Reliably surface an existing window to the user. macOS separates window
   * focus from app activation: a backgrounded app will NOT come to the front
   * on `win.focus()` alone (electron/electron#19920) — so an agent-driven
   * "focus this page" that lands on an already-open window would silently
   * leave OpenKnowledge behind whatever app the user is in. The recipe is
   * restore → show → moveTop → focus → app-level steal. We skip the steal when
   * the window is already the key window (e.g. the built-in terminal focusing
   * a doc in its own active window) so we never yank focus from a window that
   * already has it. Single source of truth for all focus-an-existing-window
   * paths (deep-link warm path + the createProjectWindow / ephemeral dedup
   * branches).
   *
   * `opts.activate: false` performs the same raise WITHOUT pulling the app to
   * the foreground — for callers that want a window ordered correctly but must
   * not take the user out of whatever app they are currently in (the
   * post-restore raise, when the user walked away mid-restore). Measured on
   * macOS: `show()` activates the app, while `showInactive()`, `moveTop()`,
   * and `focus()` do not. So the non-activating path swaps the reveal and drops
   * the app-level steal, but keeps `moveTop()` + `focus()` — the window still
   * becomes the one OpenKnowledge surfaces when the user returns on their own.
   */
  private bringToFront(win: BrowserWindowLike, opts?: { activate?: boolean }): void {
    const activate = opts?.activate ?? true;
    if (win.isMinimized?.()) win.restore?.();
    if (activate) {
      win.show?.();
    } else if (win.isVisible?.() !== true) {
      // Reveal a still-hidden window without foregrounding the app. `show()` is
      // the fallback only when `showInactive` is absent (test mocks) — a
      // window the caller asked for must never stay invisible.
      if (win.showInactive !== undefined) win.showInactive();
      else win.show?.();
    }
    const alreadyFrontmost = win.isFocused?.() === true;
    win.moveTop?.();
    win.focus();
    if (activate && !alreadyFrontmost) this.deps.activateApp?.();
  }

  /**
   * Resolve the ProjectContext that owns a given BrowserWindow. Used by IPC
   * handlers that receive `event.sender.webContents` → BrowserWindow and need
   * to look up the window's project. Iterates `windowsByPath` (authoritative
   * map) instead of going through `appState.recentProjects`, which avoids a
   * stale-state race between `createProjectWindow` resolving and
   * `addRecentProject` persisting.
   *
   * Falls back to `loadingContextByWindow` so a window with no authoritative
   * entry resolves too — still loading its renderer, or detached by a server
   * restart. See that field for both spans. Both maps hold the SAME context
   * object, so callers cannot tell which one answered.
   *
   * A window detached by a restart answers with the `port`/`apiOrigin` of the
   * server that restart just terminated. Deliberate: `projectPath` is what
   * nearly every caller reads and it does not change across a restart, and the
   * recreate-failure branch restores this very context — dead origin and all —
   * into `windowsByPath` for as long as the failure stands, provided the window
   * survived the wait. If it was destroyed meanwhile nothing is restored and
   * this answers `undefined` again, which no caller can observe because the
   * window is gone. So the in-flight span agrees with the state on either side
   * of it rather than inventing a third. On a SUCCESSFUL recreate, a note
   * window opened against it is rebuilt on the fresh origin by
   * `onProjectServerRestarted`; that hook sits past the failure return, so a
   * failed recreate rebuilds nothing. A terminal window is never rebuilt on
   * either outcome, and keeps the dead collab URL for its lifetime.
   *
   * The restart answer stops the moment the replacement's authoritative entry
   * lands, so one project is never answered for by two windows at once.
   */
  getContextForBrowserWindow(win: BrowserWindowLike): ProjectContext | undefined {
    for (const ctx of this.windowsByPath.values()) {
      if (ctx.window === win) return ctx;
    }
    // No authoritative entry: still loading its renderer, or detached by a
    // server restart. The docblock above says how the two differ.
    return this.loadingContextByWindow.get(win);
  }

  /**
   * Publish a window's context for as long as no authoritative `windowsByPath`
   * entry answers for it, and hand back the release.
   *
   * On a create path the bracket MUST enclose `windowsByPath.set`, NOT just the
   * load. A `finally` wrapped around only the `await` releases the moment the
   * load settles — before the authoritative entry exists — which reopens the
   * exact window this map was added to close, in the one function that
   * implements the fix. Bracket the whole span: publish, load, `set`, release.
   *
   * Releasing after `set` is safe because both maps hold the SAME object and
   * `getContextForBrowserWindow` reads `windowsByPath` first, so the overlap is
   * invisible. Release is idempotent, so a path that must also release early
   * (the ephemeral reap, which stops a `destroy()`ed window resolving before it
   * awaits teardown) can do that and still keep the bracket as its backstop.
   *
   * The server-restart publisher brackets a different span — the detach of the
   * originating window until the replacement owns the authoritative entry, or,
   * on failure, until the restore puts the old one back. It releases explicitly
   * on the success path, ahead of the close, so one project is never answered
   * for by two windows; the bracket then covers the failure return and anything
   * the close throws. An unreleased publish is a permanent entry pinning a
   * destroyed BrowserWindow.
   */
  private publishLoadingContext(context: ProjectContext): () => void {
    this.loadingContextByWindow.set(context.window, context);
    return () => {
      this.loadingContextByWindow.delete(context.window);
    };
  }

  /**
   * User-facing project paths for every live project window. Used by the
   * pre-relaunch teardown to snapshot what was open so the post-update boot
   * can restore all of them — not just `lastOpenedProject`.
   *
   * Returns `projectPath` (as the user picked it, possibly symlinked), not
   * `canonicalKey` — `openProject` re-runs discovery on the input path.
   * Skips contexts whose BrowserWindow is already destroyed (a close that
   * raced the snapshot): the `utility.exit` listener clears such entries
   * asynchronously, so the map can briefly hold a destroyed window.
   */
  getOpenProjectPaths(): string[] {
    const paths: string[] = [];
    for (const ctx of this.windowsByPath.values()) {
      if (ctx.window.isDestroyed?.() === true) continue;
      paths.push(ctx.projectPath);
    }
    return paths;
  }

  /**
   * Every live window as a kinded restore descriptor — a project window keyed
   * by its (possibly symlinked) `projectPath`, or a loose single-file window
   * keyed by its canonical file path. The session-restore snapshot source,
   * superseding `getOpenProjectPaths` (which flattened an ephemeral window to
   * its parent directory, so a restored loose file reopened as a full project).
   * Skips destroyed windows, same as `getOpenProjectPaths`.
   */
  getOpenWindows(): RestoredWindow[] {
    const windows: RestoredWindow[] = [];
    for (const ctx of this.windowsByPath.values()) {
      if (ctx.window.isDestroyed?.() === true) continue;
      windows.push(
        ctx.ephemeral !== undefined
          ? { kind: 'file', filePath: ctx.canonicalKey }
          : { kind: 'project', projectPath: ctx.projectPath },
      );
    }
    return windows;
  }

  windowCount(): number {
    return this.windowsByPath.size;
  }

  /**
   * Gracefully shut down every detached server THIS desktop process spawned
   * during its lifetime. Called from the auto-updater's pre-`quitAndInstall`
   * hook so the relaunched desktop starts fresh against new-version servers
   * rather than attaching to stale ones.
   *
   * Two-phase:
   *   1. SIGTERM each pid in `spawnedDetachedPids`. Servers' SIGTERM
   *      handlers call `bootedServer.destroy()` → Hocuspocus drain → lock
   *      release.
   *   2. Poll `<contentDir>/.ok/local/server.lock` every
   *      `DEFAULT_SIGTERM_POLL_MS` (200 ms) until the lock disappears OR
   *      `DEFAULT_SIGTERM_GRACE_MS` (10 s) elapses. Per-pid; pids that
   *      release fast don't slow down the overall wall-clock.
   *   3. Any pid whose lock is still present at the deadline gets SIGKILL
   *      + a structured warn (`auto-update-server-stop-escalated`).
   *
   * Skips servers the desktop merely ATTACHED to (i.e., not in
   * `spawnedDetachedPids` — MCP-spawned servers, sibling CLI servers,
   * prior-desktop-session servers). The detached-server lifecycle model
   * is "the spawner is responsible for cleanup" — we don't reach across
   * spawn-session boundaries.
   *
   * Also kills any utility-fork pids the dev path may have spawned —
   * those have utilities in `windowsByPath` (`ownsServer === true`) and
   * are real Electron `utilityProcess.fork` children. Killing them
   * preempts the parent-death poll for a clean process tree before
   * `quitAndInstall`. Idempotent within a call; safe to invoke twice.
   *
   * Returns once all in-scope pids have either released their lock or
   * received SIGKILL. The auto-updater awaits this before invoking
   * `quitAndInstall`.
   */
  async stopAllOwnedServers(): Promise<void> {
    // Utility-fork pids (dev path) — hard-kill immediately. These are
    // children of Electron's process tree and would die anyway on
    // `quitAndInstall`, but ShipIt's pre-swap not-still-running validation
    // (the `SQRLInstallerErrorDomain Code=-9 "App Still Running"` failure)
    // wants the tree clean BEFORE it looks.
    signalStopOwnedUtilityForks(this.windowsByPath.values(), this.deps.log);

    // Detached-spawn pids — two-phase SIGTERM → poll → SIGKILL.
    const stopOne = async (canonicalKey: string, pid: number): Promise<void> => {
      // The map key IS `realpathSync(resolve(projectPath))`, so the lock
      // directory is computable directly without depending on
      // `windowsByPath`. If the user closed the window before auto-update
      // fired, `window.on('closed')` already deleted that entry — looking
      // it up here would return `undefined` and silently skip the grace
      // poll, sending SIGKILL on top of an in-flight Hocuspocus drain.
      // This is the exact scenario the spec is designed for (MCP agents
      // writing while the editor window is closed).
      const projectPath = canonicalKey;
      // SIGTERM first. `killProbe` (test-injectable wrapper around
      // `process.kill`) throws if the pid is already gone (ESRCH) — treat
      // that as success (server already exited, we're done with this entry).
      try {
        this.deps.killProbe(pid, 'SIGTERM');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          return;
        }
        this.deps.log?.warn({ err, pid, projectPath }, 'SIGTERM failed during stopAllOwnedServers');
      }
      // Poll for PROCESS death, not lock release. The lock disappears while
      // the process is still flushing telemetry/logs (and historically,
      // seconds before exit) — treating lock-gone as stopped is exactly the
      // window that let a relaunch spawn a duplicate alongside a live
      // predecessor. Pid death is the only signal that means "gone".
      {
        const graceMs = this.deps.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS;
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline) {
          if (!this.isPidAlive(pid)) return;
          await new Promise<void>((resolveSleep) => {
            this.deps.setTimeout(() => {
              resolveSleep();
            }, DEFAULT_SIGTERM_POLL_MS);
          });
        }
      }
      // SIGKILL — graceful drain timed out (or back-compat path).
      // Narrowed catch: ESRCH means the SIGTERM target already exited
      // between our poll check and the SIGKILL syscall (clean shutdown);
      // EPERM means the running user can't signal the pid (cross-user
      // process or other privilege barrier) which leaves the server
      // running. Surface both via warn-level structured logs so the
      // failure mode is diagnosable rather than silently dropped.
      try {
        this.deps.killProbe(pid, 'SIGKILL');
        this.deps.log?.warn(
          { event: 'auto-update-server-stop-escalated', pid, projectPath },
          '[window-manager] SIGTERM grace expired — escalated to SIGKILL',
        );
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return;
        this.deps.log?.warn(
          {
            event: 'auto-update-server-stop-sigkill-failed',
            err,
            code,
            pid,
            projectPath,
          },
          '[window-manager] SIGKILL escalation failed — server may still be running',
        );
      }
    };
    // Stop all pids in parallel — independent waits run concurrently to
    // bound the total wall-clock at `DEFAULT_SIGTERM_GRACE_MS` rather than
    // (N × grace). Drains the tracking map as we go so retry semantics are
    // clean (a second call is a no-op).
    const entries = [...this.spawnedDetachedPids.entries()];
    this.spawnedDetachedPids.clear();

    // Ephemeral single-file sessions track their teardown state on the
    // ProjectContext (NOT `spawnedDetachedPids` — see `ProjectContext.ephemeral`),
    // so reap them in the same pre-relaunch pass. Their per-window `'closed'`
    // teardown also fires on app-quit, but quitAndInstall does not await those
    // async handlers — terminating here bounds the leak. Idempotent with the
    // `'closed'` path (ESRCH + force-rm on a second pass).
    const ephemeralSessions = [...this.windowsByPath.values()]
      .map((ctx) => ctx.ephemeral)
      .filter((e): e is NonNullable<ProjectContext['ephemeral']> => e !== undefined);

    await Promise.all([
      ...entries.map(([key, pid]) => stopOne(key, pid)),
      ...ephemeralSessions.map((session) => this.teardownEphemeralSession(session)),
    ]);
  }

  /**
   * Synchronous, best-effort SIGTERM of every detached server THIS desktop
   * spawned — the sibling of `stopAllOwnedServers` for contexts that cannot
   * await. Fired from the `before-quit-for-update` lifecycle handler, which is
   * the single signal emitted on BOTH install paths (the "Relaunch now"
   * `quitAndInstall()` and the silent `autoInstallOnAppQuit` install-on-quit)
   * and ONLY on an update install — never a plain quit. The "Relaunch now"
   * path already drained the map via `prepareForRelaunch` → `stopAllOwnedServers`
   * before reaching here, so this no-ops there; it does the real work on the
   * silent install-on-quit path, which has no `prepareForRelaunch` hook.
   *
   * Why a stale detached server matters at update time: it survives app-quit by
   * design (it runs detached off `process.execPath`, the bundle's Electron
   * binary). If it outlives the swap, the relaunched app attaches to it, reads
   * an older version off `server.lock`, and shows the version-drift toast — the
   * "every update" complaint. A still-alive bundle-process can also trip
   * ShipIt's pre-swap "App Still Running" check. Killing it here removes both.
   *
   * Best-effort by necessity: `before-quit-for-update` cannot hold the quit open
   * for the grace-poll ladder, so this only sends the signal — but the server's
   * own SIGTERM handler drains and flushes pending writes before releasing the
   * lock (~25ms measured), well inside the multi-second reinstall+relaunch
   * window, so the lock is gone before the new app could re-attach. Drains
   * `spawnedDetachedPids` so a second call is a no-op.
   */
  signalStopAllOwnedServers(): void {
    // Utility-fork pids (dev path) — hard-kill, shared with `stopAllOwnedServers`.
    signalStopOwnedUtilityForks(this.windowsByPath.values(), this.deps.log);

    // Detached project servers (`spawnedDetachedPids`) plus ephemeral single-file
    // session servers. Ephemeral pids live on `ctx.ephemeral` (keyed by file path,
    // not project root — see `ProjectContext.ephemeral`), so the async sibling
    // reaps them separately; signal them here too so an open `ok <file>` server
    // doesn't orphan on the silent install path. The temp-dir removal is the
    // async half this best-effort path can't do — but the orphaned process (which
    // holds the bundle binary) is what matters, and it dies on this SIGTERM.
    const detached = [...this.spawnedDetachedPids.entries()];
    this.spawnedDetachedPids.clear();
    const ephemeral = [...this.windowsByPath.values()]
      .map((ctx) => ctx.ephemeral)
      .filter((e): e is NonNullable<ProjectContext['ephemeral']> => e !== undefined)
      .map((e) => [e.projectDir, e.pid] as const);
    const entries = [...detached, ...ephemeral];
    const signalled = signalDetachedServerStop(entries, this.deps.killProbe, this.deps.log);
    if (entries.length > 0) {
      this.deps.log?.info(
        { event: 'update-install-server-stop', count: entries.length, signalled },
        '[window-manager] signalled owned detached servers to stop for update install',
      );
    }
  }

  /**
   * Pid liveness probe for the SIGTERM grace polls. Prefers the injected
   * `isProcessAlive` (shared with attach validation); falls back to a
   * signal-0 `killProbe` so tests that wire only `killProbe` keep working.
   * EPERM means "exists but not signalable" — alive.
   */
  private isPidAlive(pid: number): boolean {
    const probe = this.deps.isProcessAlive;
    if (probe) return probe(pid);
    try {
      this.deps.killProbe(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  /**
   * Whether the detached server backing an ephemeral single-file session is
   * still live. The ephemeral dedup and the exit-watch must gate on SERVER
   * liveness, not just WINDOW liveness — a detached server can die (kill /
   * crash / idle-shutdown) while its window stays open, leaving the cached
   * `apiOrigin` pointing at nothing.
   *
   * Pid liveness is authoritative: `isPidAlive` always has a probe (it falls
   * back to the required `killProbe` dep), so there is no configuration in which
   * a dead server reads as alive, and a dead pid is dead regardless of a stale
   * lock a SIGKILL left behind. When the pid IS alive, a gone or `draining` lock
   * still counts as dead — that is a server mid-shutdown (the same signal
   * `pollServerLock` treats as not-ready) whose pid has not exited yet. With no
   * lock reader wired, the live pid is trusted on its own.
   */
  private isEphemeralServerAlive(ctx: ProjectContext): boolean {
    const eph = ctx.ephemeral;
    if (eph === undefined) return true; // not an ephemeral ctx — nothing to probe
    if (!this.isPidAlive(eph.pid)) return false;
    const reader = this.deps.readServerLock;
    if (!reader) return true; // pid alive, no lock reader to corroborate — trust it
    const lock = reader(eph.lockDir);
    return lock !== null && lock.draining !== true;
  }

  /**
   * Terminate a server by pid using the same SIGTERM → grace-poll → SIGKILL
   * ladder as `stopAllOwnedServers`, but returning a caller-consumable outcome
   * instead of fire-and-forget logging. Used by `restartAttachedServer` to
   * tear down a NOT-owned server (pid from its lock) before recreating the
   * window. EPERM (cross-user pid) surfaces distinctly so the renderer can
   * show the "running under a different account" remedy. Uses a shorter
   * `RESTART_SIGTERM_GRACE_MS` (vs the auto-update teardown's 10 s) but shares
   * `killProbe` / `readServerLock` / the poll interval with that path.
   */
  private async terminateServerByPid(
    _lockDir: string,
    pid: number,
  ): Promise<{ ok: true; escalated: boolean } | { ok: false; reason: 'eperm' | 'other' }> {
    try {
      this.deps.killProbe(pid, 'SIGTERM');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return { ok: true, escalated: false };
      return { ok: false, reason: code === 'EPERM' ? 'eperm' : 'other' };
    }
    {
      // Poll for PROCESS death, not lock release — lock-gone precedes exit
      // (see `stopAllOwnedServers`), and respawning inside that window is
      // the duplicate-server bug. Restart-specific grace (shorter than the
      // auto-update teardown). Test override via `sigtermGraceMs` still wins.
      const graceMs = this.deps.sigtermGraceMs ?? RESTART_SIGTERM_GRACE_MS;
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline) {
        if (!this.isPidAlive(pid)) return { ok: true, escalated: false };
        await new Promise<void>((resolveSleep) => {
          this.deps.setTimeout(() => resolveSleep(), DEFAULT_SIGTERM_POLL_MS);
        });
      }
    }
    try {
      this.deps.killProbe(pid, 'SIGKILL');
      return { ok: true, escalated: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return { ok: true, escalated: true };
      return { ok: false, reason: code === 'EPERM' ? 'eperm' : 'other' };
    }
  }

  /**
   * The one rule for an unkillable lock holder, shared by both entry states
   * that can meet one: `restartAttachedServer` (reached from an OPEN project
   * window) and `forceStopConflictingServer` (reached from the failed-open
   * dialog, when there is no window). Keeping a single rule is the point — a
   * holder that is unrecoverable from one entry state and recoverable from the
   * other is the shape that left a real project unopenable for three days.
   *
   * "Cannot be signalled" and "is serving" are separate facts. EPERM only says
   * the holder exists and is not ours to kill: an MCP-spawned server, or a pid
   * the OS has reused. Nothing else clears that lock either — `runClean` prunes
   * only dead-pid and corrupt locks, and its classifier reads EPERM as alive.
   *
   * So ask the holder — but only once it names somewhere to ask. A lock naming
   * no dialable origin at all is broken outright and breaks without a probe;
   * past that there are three outcomes, not two. A holder that has not bound
   * yet (the `port: 0` boot sentinel) is left
   * alone, because a probe that cannot succeed is not evidence of anything. A
   * holder that answers is a live server we simply do not own; refuse, and let
   * the caller surface the cross-account remedy, because breaking that lock
   * would strand a running server and put a second one on the same project. A
   * holder that answers nothing is stale in effect however alive its pid looks,
   * so break the claim and let the caller proceed.
   *
   * Returns whether the lock was broken. Scoped to `eperm` by the callers: an
   * `other` termination failure says nothing about whether the holder serves.
   */
  private async breakUnservingHolderLock(args: {
    lockDir: string;
    // Only what the decision needs: the identity to guard the unlink on, and
    // enough to address the port. Narrower than `ServerLockMetadataLike` so the
    // force-stop caller, which reads the lock raw precisely because the
    // identity-filtered reader refuses these holders, can pass what it actually
    // parsed instead of casting a partial object into a full one.
    lock: Pick<ServerLockMetadataLike, 'pid' | 'url'> & { port: unknown };
    projectPath: string;
    // ONE discriminator for one fact. The log event and the probe phase are two
    // views of "which entry state is asking", so taking them separately lets a
    // caller pair a restart event with a force-stop phase and nothing would
    // notice. Mapped once, exhaustively, below.
    caller: RecoveryCaller;
  }): Promise<boolean> {
    const { lockDir, lock, projectPath, caller } = args;
    const { event, phase } = RECOVERY_CALLERS[caller];
    // A port of 0 is the acquired-but-not-yet-bound sentinel a lock carries
    // during boot. The probe cannot succeed against it, so it would read as
    // "not serving" and break the lock of a server that is still coming up.
    //
    // This lives in the RULE, not at a caller. The whole point of this helper is
    // that both entry states decide the same way, and a guard installed at one
    // of them leaves the other free to do the damage.
    const port = lock.port;
    // Two different states hide behind "the port is not dialable", and treating
    // them alike gets one of them wrong.
    //
    // `0` is the acquired-but-not-yet-bound sentinel: a server mid-boot, which
    // will have a real port shortly. Leave it alone — it is the one case where
    // waiting is correct.
    //
    // A lock that names nowhere to dial (absent, `Infinity`, out of range, a
    // fraction) cannot denote a listening server at all, so there is nothing to
    // strand and no reason to keep the claim. Refusing here would be worse than
    // useless: nothing else prunes these, so the project would stay wedged —
    // the exact failure this whole change exists to end. A numeric STRING is
    // NOT in this set: it renders into a live address, so it goes to the probe.
    if (!lockMayHaveServer(lock)) {
      if (port === 0) {
        this.deps.log?.warn(
          {
            event,
            outcome: 'eperm-stale-lock-break-skipped',
            reason: 'booting',
            pid: lock.pid,
            projectPath,
          },
          '[window-manager] holder has not bound a port yet — leaving its lock alone',
        );
        return false;
      }
      this.deps.log?.warn(
        // Port carried raw: for a lock this shape the value IS the diagnosis.
        // A DECISION, not the result: the unlink below can still decline or
        // fail, and `-broken` is the value that means it did not.
        {
          event,
          outcome: 'eperm-stale-lock-break-decided',
          reason: 'unservable-origin',
          pid: lock.pid,
          port,
          projectPath,
        },
        '[window-manager] holder names nowhere that could serve — breaking its stale lock',
      );
      return this.unlinkHolderLock({ lockDir, lock, projectPath, event });
    }
    const dialable = { pid: lock.pid, port, url: lock.url };
    // The graced probe, not a single shot. This path is the DESTRUCTIVE one —
    // it deletes another process's claim — so it should not settle for less
    // confidence than the spawn path, which only declines to adopt. A transient
    // refusal here breaks a live server's lock; there it costs a retry.
    if (await this.probeForeignLockWithGrace(dialable, phase)) return false;
    // Identity-guarded: the verdict above is about THIS holder, and the probe
    // it rests on took long enough for that holder to exit and a fresh server
    // to take the lock.
    //
    // Reporting what HAPPENED, not what was intended. The dep is optional, its
    // identity guard can decline, and the unlink can fail on a read-only or
    // otherwise hostile `.ok` directory — claiming "broken" through any of those
    // would tell the next diagnosis the lock is gone when it is still there, the
    // same false-record failure the recovery rule one branch over avoids. It
    // also must not
    // throw: this is the recovery path for a wedged project, and replacing a
    // stuck project with a crashed app is a strictly worse outcome.
    return this.unlinkHolderLock({ lockDir, lock, projectPath, event });
  }

  /**
   * The unlink half of the rule: identity-guarded, non-throwing, and honest
   * about whether it actually removed anything. Shared by both break paths so
   * neither can drift from the other.
   */
  private unlinkHolderLock(args: {
    lockDir: string;
    lock: Pick<ServerLockMetadataLike, 'pid'> & { port?: unknown };
    projectPath: string;
    event: string;
  }): boolean {
    const { lockDir, lock, projectPath, event } = args;
    let broke = false;
    try {
      broke = this.deps.removeServerLock?.(lockDir, { pid: lock.pid }) ?? false;
    } catch (err) {
      this.deps.log?.warn(
        { event, outcome: 'eperm-stale-lock-break-failed', err, pid: lock.pid, projectPath },
        '[window-manager] could not break the stale lock',
      );
      return false;
    }
    if (!broke) {
      this.deps.log?.warn(
        { event, outcome: 'eperm-stale-lock-break-declined', pid: lock.pid, projectPath },
        // Deliberately does not name a cause: the break declines on an identity
        // mismatch, an already-gone file, or a failed unlink, and this layer
        // cannot tell which. Asserting one would be the same false-record
        // failure this path exists to avoid.
        '[window-manager] stale lock was not broken',
      );
      return false;
    }
    this.deps.log?.warn(
      {
        event,
        outcome: 'eperm-stale-lock-broken',
        pid: lock.pid,
        port: lock.port,
        projectPath,
      },
      // Neutral about WHY: the caller has already logged whether the holder
      // failed its probe or advertised a port nothing could serve.
      "[window-manager] broke the unkillable holder's stale lock",
    );
    return true;
  }

  /**
   * Explicit-user-consent recovery: stop whatever process holds this
   * project's server.lock so a fresh open can proceed. Reached from the
   * "Unable to open project" dialog's "Stop Server & Retry" button after a
   * spawn collided with a holder that attach refused (foreign machineId
   * after a hostname flap on a legacy lock, a tampered lock file, a wedged
   * teardown that outlived the drain wait).
   *
   * Reads the RAW lock pid — deliberately bypassing `readServerLock`'s
   * machine-identity filter, because the defining feature of this state is
   * that identity checks refused the holder. Safe because it only runs on an
   * explicit user click, the pid is range-validated, and never targets our
   * own process. Uses the same SIGTERM → pid-death poll → SIGKILL ladder as
   * the restart path. The dead holder's lock file is left behind for
   * acquire-side dead-pid stale detection to replace on the retry.
   */
  async forceStopConflictingServer(
    projectPath: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'eperm' | 'other' }> {
    const lockDir = getLocalDir(resolve(projectPath));
    let pid: unknown;
    let rawPort: unknown;
    let rawUrl: unknown;
    try {
      const raw = JSON.parse(readFileSync(join(lockDir, 'server.lock'), 'utf-8')) as {
        pid?: unknown;
        port?: unknown;
        url?: unknown;
      };
      pid = raw?.pid;
      rawPort = raw?.port;
      rawUrl = raw?.url;
    } catch {
      // No lock / unreadable — nothing to stop; the retry will proceed.
      return { ok: true };
    }
    if (!isValidLockPidLocal(pid) || pid === process.pid) {
      return { ok: true };
    }
    const term = await this.terminateServerByPid(lockDir, pid);
    // The dialog behind this call is the ONLY remedy a user has while the
    // project has no window, so an EPERM dead-end here is terminal in a way the
    // restart path's is not. Same two-fact rule, same safety argument: a holder
    // that answers its port is still refused.
    //
    // The probe target is built from the RAW fields above, NOT `readServerLock`.
    // That reader applies the machine-identity filter this whole method exists
    // to bypass, and it would refuse exactly the holders EPERM implies — a
    // different account, a foreign-looking machineId, a hostname flap — leaving
    // the one no-window remedy silently inert for its most likely cohort.
    if (!term.ok && term.reason === 'eperm') {
      const broke = await this.breakUnservingHolderLock({
        lockDir,
        lock: {
          pid,
          port: rawPort,
          ...(typeof rawUrl === 'string' ? { url: rawUrl } : {}),
        },
        projectPath,
        caller: 'force-stop',
      });
      if (broke) return { ok: true };
    }
    this.deps.log?.info(
      {
        event: 'desktop-force-stop-conflicting-server',
        pid,
        projectPath,
        outcome: term.ok ? 'stopped' : term.reason,
      },
      '[window-manager] force-stopped conflicting server holder on user request',
    );
    return term.ok ? { ok: true } : term;
  }

  /**
   * Restart a project's server to match this app's version. Terminates the
   * attached (not-owned) server the window connected to, then recreates the
   * window via `createProjectWindow` (no lock → fresh own-version spawn).
   *
   * Failure handling is the load-bearing part: on a termination failure the
   * originating window is untouched and the outcome (`eperm`/`other`) returns
   * for the renderer to surface. On a *post-kill* recreate failure (e.g. the
   * fresh spawn never binds within `pollServerLock`), the originating window is
   * kept ALIVE — detached from the map so the recreate spawns a new window, but
   * not closed — so its pending invoke resolves with `{ ok:false }` and the
   * renderer can surface the remedy on a surviving window. The originating
   * window is closed only after the new one is successfully created.
   *
   * The originating window stays on screen and focusable for the whole
   * recreate, so its context is published for that span (see
   * `getContextForBrowserWindow`) and released on every exit.
   */
  async restartAttachedServer(
    projectPath: string,
    opts?: { localOpCliArgs?: string[] },
  ): Promise<OkServerRestartOutcome> {
    const resolved = resolve(projectPath);
    const canonicalKey = this.canonicalizeKey(resolved);
    const lockDir = getLocalDir(resolved);
    const lock = this.deps.readServerLock?.(lockDir) ?? null;
    if (lock && isValidLockPidLocal(lock.pid)) {
      const term = await this.terminateServerByPid(lockDir, lock.pid);
      if (!term.ok) {
        // Scoped to `eperm` — see `breakUnservingHolderLock` for the rule, and
        // why an `other` failure keeps the conservative refusal.
        const broke =
          term.reason === 'eperm' &&
          (await this.breakUnservingHolderLock({
            lockDir,
            lock,
            projectPath: resolved,
            caller: 'restart',
          }));
        if (!broke) {
          this.deps.log?.warn(
            {
              event: 'desktop-server-restart',
              outcome: term.reason,
              pid: lock.pid,
              projectPath: resolved,
            },
            '[window-manager] server restart could not terminate the attached server',
          );
          return term;
        }
      } else {
        // Only the genuine kill reports `terminated`. The lock-broken path above
        // falls through to the same recreate but terminated nothing, and saying
        // otherwise would misreport the one event a future diagnosis reads to
        // learn whether the old server actually went away.
        this.deps.log?.info(
          {
            event: 'desktop-server-restart',
            outcome: 'terminated',
            escalated: term.escalated,
            pid: lock.pid,
            appRuntime: this.deps.selfRuntimeVersion ?? null,
            projectPath: resolved,
          },
          '[window-manager] terminated attached server for restart',
        );
      }
    }
    // Detach the originating window from the map (so the recreate spawns a new
    // window instead of focusing the old) but keep it open until the new one
    // exists — see the failure branch below. It stays on screen and focusable
    // for that whole span, so publish its context: without it the menu acting
    // on that window resolves no project at all. The release brackets every
    // exit below, including the failure return — a publish left behind pins a
    // destroyed BrowserWindow forever.
    const originating = this.windowsByPath.get(canonicalKey);
    let releaseOriginatingContext: (() => void) | undefined;
    if (originating) {
      this.windowsByPath.delete(canonicalKey);
      releaseOriginatingContext = this.publishLoadingContext(originating);
    }
    try {
      let recreated: ProjectContext;
      try {
        recreated = await this.createProjectWindow({
          projectPath: resolved,
          pendingServerRestartedToast: true,
          localOpCliArgs: opts?.localOpCliArgs,
        });
      } catch (err) {
        this.deps.log?.warn(
          {
            event: 'desktop-server-restart',
            outcome: 'recreate-failed',
            // Full error (stack + name), not just the message — a respawn failure
            // is a rare, important diagnostic.
            err: err instanceof Error ? (err.stack ?? err.message) : String(err),
            projectPath: resolved,
          },
          '[window-manager] server restart killed the old server but could not respawn',
        );
        // Restore the originating window as the project's window so its pending
        // invoke resolves with the failure below; its still-live renderer then
        // surfaces `restartFailureMessage('other')`.
        if (originating && originating.window.isDestroyed?.() !== true) {
          this.windowsByPath.set(canonicalKey, originating);
        }
        return { ok: false, reason: 'other' };
      }
      // The replacement now holds the authoritative entry for this project, so
      // the originating window must stop answering for it — otherwise one
      // project has two answers while the old window is torn down, and the
      // per-project state its renderer can still write (session state, terminal
      // dock, sharing) would clobber what the replacement just restored.
      // `closeAndAwait` grants a two-second grace and a `beforeunload` veto can
      // consume all of it, so that overlap is not instantaneous. Releasing early
      // is the shape `publishLoadingContext` sanctions; the outer bracket stays
      // as the backstop.
      releaseOriginatingContext?.();
      // The project window is back on the fresh server. Note windows are not in
      // `windowsByPath`, so they were not recreated above and still hold argv
      // pointing at the terminated server — recreate them before the old window
      // closes, so the pop-outs come back with the project rather than lingering
      // as permanently disconnected windows.
      //
      // Isolated in its own try/catch: the note-window recreate is a SECONDARY
      // concern, so a throw in the injected callback (a `BrowserWindow`
      // constructor failure under memory pressure, say) must not skip the
      // `closeAndAwait` teardown below and strand the old window as a zombie
      // pointing at the terminated server.
      try {
        this.deps.onProjectServerRestarted?.({
          projectPath: resolved,
          apiOrigin: recreated.apiOrigin,
        });
      } catch (err) {
        this.deps.log?.warn(
          {
            event: 'desktop-server-restart',
            outcome: 'note-recreate-failed',
            err: err instanceof Error ? (err.stack ?? err.message) : String(err),
            projectPath: resolved,
          },
          '[window-manager] project window recreated, but a note-window recreate threw',
        );
      }
      if (originating) await this.closeAndAwait(originating.window);
      return { ok: true };
    } finally {
      releaseOriginatingContext?.();
    }
  }

  /**
   * The restart identity for a window, if it is an ephemeral single-file window.
   * Looks up the durable `ephemeralWindowIdentity` map (NOT `windowsByPath`), so
   * it still resolves a dead window that a re-open has orphaned from the slot
   * map — the case where routing a restart to the project path produced the
   * error-toast loop. Returns `undefined` for project windows.
   *
   * Public for the DI test harness (which resolves the identity the IPC would
   * hand `restartEphemeralServer`); production routes through the sibling
   * `restartServerForWindow`, which calls this internally.
   */
  getEphemeralIdentityForWindow(win: BrowserWindowLike): EphemeralOpenIdentity | undefined {
    return this.ephemeralWindowIdentity.get(win);
  }

  /**
   * Restart the server for an ephemeral single-file window (the "server gone"
   * affordance's action). `restartAttachedServer` is directory-keyed and cannot
   * reach a file-keyed ephemeral session (its lock lives under a throwaway
   * `$TMPDIR/ok-ephemeral-*` dir, keyed by the canonical FILE path) — routing a
   * single-file restart there failed with a retry-toast loop. Instead respawn
   * through `createEphemeralWindow`, which then retires every other window for the
   * file, converging to a single live window. Routed here from the IPC by the
   * durable `ephemeralWindowIdentity` lookup, so it works even for a dead window a
   * re-open already orphaned from `windowsByPath`.
   *
   * A restart must *actually restart*: `createEphemeralWindow` normally DEDUPS
   * onto a live server (correct for `ok open <file>`, wrong here — it would focus
   * the window, spawn nothing, and resolve `{ ok: true }` having restarted
   * nothing, which the renderer reads as "torn down and recreated" and shows no
   * feedback). So when a live session for this file still exists — e.g. the
   * DocumentErrorBoundary reach-error path fires while the process is alive but
   * sync is wedged — terminate it and evict its slot FIRST, forcing the recreate
   * to spawn a fresh server. A dead session needs no pre-teardown; the recreate's
   * own stale-entry path reaps it. The fresh window IS the success signal (the
   * old originating window is closed by the recreate's `retireStaleWindowsForFile`
   * sweep, so the caller's invoke rejects and stops — the contract
   * `restartCollabServer` already expects), so there is no separate
   * `ok:server-restarted` toast to thread as `restartAttachedServer` does.
   *
   * No `onProjectServerRestarted` (the sibling's note-window recreate): an
   * ephemeral single-file session structurally cannot pop out note windows
   * (`open-in-new-window` is `singleFileHidden`), so there is nothing to recreate.
   *
   * `requestingWindow` gates the live-terminate to slot OWNERSHIP: the live server
   * is torn down only when the window that asked is the one currently holding the
   * file's slot (the wedged-but-alive case it is written for). A superseded window
   * that a re-open orphaned from the slot (its live sibling now owns it) must NOT
   * terminate that healthy sibling — it falls through to `createEphemeralWindow`,
   * which dedups onto the live sibling and retires the orphan. Convergence
   * normally closes such orphans first, so this is a guard on the narrow
   * `closeAndAwait` grace window. Required rather than optional so a caller cannot
   * omit it and silently fall into the dedup-only path — that returns
   * `{ ok: true }` having spawned nothing, the outcome this method exists to
   * prevent.
   */
  async restartEphemeralServer(
    identity: EphemeralOpenIdentity,
    requestingWindow: BrowserWindowLike,
  ): Promise<OkServerRestartOutcome> {
    this.deps.log?.info(
      {
        event: 'desktop-ephemeral-restart',
        outcome: 'requested',
        file: identity.canonicalFilePath,
      },
      '[window-manager] ephemeral server restart requested',
    );
    try {
      const canonicalKey = this.canonicalizeKey(identity.canonicalFilePath);
      const current = this.windowsByPath.get(canonicalKey);
      if (
        current &&
        current.window === requestingWindow &&
        current.window.isDestroyed?.() !== true &&
        this.isEphemeralServerAlive(current)
      ) {
        // Live server + open window + the requester owns the slot: this is the
        // "restart raced a healthy (but wedged) server" case. Evict the slot,
        // close its keepalive, and terminate the server so the recreate below
        // cannot dedup back onto it.
        this.deps.log?.info(
          {
            event: 'desktop-ephemeral-restart',
            outcome: 'terminated-live',
            file: identity.canonicalFilePath,
          },
          '[window-manager] terminating the live ephemeral server before respawn',
        );
        this.windowsByPath.delete(canonicalKey);
        this.closeKeepalive(canonicalKey);
        if (current.ephemeral) await this.teardownEphemeralSession(current.ephemeral);
      }
      const recreated = await this.createEphemeralWindow({
        canonicalFilePath: identity.canonicalFilePath,
        contentDir: identity.contentDir,
        docName: identity.docName,
      });
      this.deps.log?.info(
        {
          event: 'desktop-ephemeral-restart',
          outcome: 'respawned',
          file: identity.canonicalFilePath,
          apiOrigin: recreated.apiOrigin,
        },
        '[window-manager] ephemeral server restart respawned',
      );
      return { ok: true };
    } catch (err) {
      this.deps.log?.warn(
        {
          event: 'desktop-ephemeral-restart',
          outcome: 'recreate-failed',
          err: err instanceof Error ? (err.stack ?? err.message) : String(err),
          file: identity.canonicalFilePath,
        },
        '[window-manager] ephemeral server restart could not respawn',
      );
      // The dead originating window stays open so its renderer surfaces failure.
      return { ok: false, reason: 'other' };
    }
  }

  /**
   * Route a renderer-initiated `ok:project:restart-server` to the correct restart
   * by the REQUESTING window, not the `projectPath` arg. An ephemeral single-file
   * window's server is file-keyed under a throwaway temp dir, so the
   * directory-keyed `restartAttachedServer` can't reach it and drops the user into
   * a retry-toast loop; the durable window→identity map resolves the ephemeral
   * case (and still resolves a dead window a re-open has orphaned from
   * `windowsByPath`). Kept here — a testable method on the class that owns the
   * maps — rather than as an inline ternary in the IPC handler, which no test tier
   * can reach.
   */
  async restartServerForWindow(
    sender: BrowserWindowLike | null,
    projectPath: string,
    opts: { localOpCliArgs?: string[] },
  ): Promise<OkServerRestartOutcome> {
    if (sender !== null) {
      const ephemeralIdentity = this.getEphemeralIdentityForWindow(sender);
      if (ephemeralIdentity !== undefined) {
        // `sender` is the window whose identity we just resolved; pass it so the
        // live-terminate is gated on that window still owning the file's slot.
        return this.restartEphemeralServer(ephemeralIdentity, sender);
      }
    }
    return this.restartAttachedServer(projectPath, opts);
  }

  /**
   * Retire (close) every OTHER open ephemeral window for `canonicalKey` besides
   * `keepWindow`. Called once `createEphemeralWindow` has landed on the live
   * window for a file, so a (re)open or restart converges to exactly one window
   * and no dead window dangles. Safe because at most one live server exists per
   * file — the one behind `keepWindow` — so every sibling window's server is
   * already dead. Each retired window's own `'closed'` handler clears its identity;
   * its teardown branch short-circuits (the ownership guard fails, since the live
   * `keepWindow` now owns the slot), which is correct — a retired window's server
   * was already reaped by the stale-entry path, the exit-watch, or the restart
   * pre-terminate before it got here. Snapshots the targets first so the
   * `'closed'`-driven map mutation cannot perturb the iteration.
   *
   * Routes through `closeAndAwait` (not a bare `close()`), so a window that never
   * emits `'closed'` — a `beforeunload` veto, a native wedge — is force-destroyed
   * rather than left open with its `ephemeralWindowIdentity` entry leaked, which
   * would defeat the "converges to exactly one window" guarantee. Fire-and-forget
   * at the call sites (they don't await convergence), so the sweep runs its
   * closes concurrently.
   */
  private retireStaleWindowsForFile(canonicalKey: string, keepWindow: BrowserWindowLike): void {
    const stale: BrowserWindowLike[] = [];
    for (const [win, identity] of this.ephemeralWindowIdentity) {
      if (win === keepWindow) continue;
      if (this.canonicalizeKey(identity.canonicalFilePath) !== canonicalKey) continue;
      stale.push(win);
    }
    if (stale.length === 0) return;
    this.deps.log?.info(
      { event: 'desktop-ephemeral-retire-stale', canonicalKey, retired: stale.length },
      '[window-manager] retiring stale ephemeral window(s) for the file',
    );
    for (const win of stale) void this.closeAndAwait(win);
  }

  /**
   * Close and drop the ephemeral keepalive for `canonicalKey`, if one is open.
   * The keepalive re-reads `<lockDir>/server.lock` every attempt, so once a
   * session's server is gone (its lockDir removed by `teardownEphemeralSession`)
   * an un-closed keepalive reconnect-loops against a path that no longer exists
   * for the window's remaining lifetime. Every PER-WINDOW teardown site — normal
   * close, exit-watch reap, stale-entry re-spawn, the restart pre-terminate — must
   * call this so the keepalive dies with the server it was holding up.
   * `stopAllOwnedServers` (relaunch/quit) does not: it runs immediately before the
   * process exits, so any surviving keepalive is bounded by that exit, not a
   * window's lifetime.
   */
  private closeKeepalive(canonicalKey: string): void {
    const keepalive = this.keepalives.get(canonicalKey);
    if (keepalive) {
      keepalive.close();
      this.keepalives.delete(canonicalKey);
    }
  }

  /**
   * Close a window and resolve once its `'closed'` event fires (the existing
   * attach `'closed'` handler runs alongside, clearing its own map/keepalive
   * slot). If the window never emits `'closed'` within the grace (beforeunload
   * veto, native wedge), force-destroy it so a restart can't strand a zombie
   * window pointing at the killed server, then resolve.
   */
  private async closeAndAwait(window: BrowserWindowLike): Promise<void> {
    if (window.isDestroyed?.() === true) return;
    await new Promise<void>((resolveClosed) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolveClosed();
      };
      window.on('closed', finish);
      window.close?.();
      this.deps.setTimeout(() => {
        if (!settled && window.isDestroyed?.() !== true) window.destroy?.();
        finish();
      }, 2_000);
    });
  }

  /**
   * Attach the external-link safety net to a freshly-created editor window, so
   * EVERY factory path (spawn + ephemeral + attach, including the
   * restart → recreate window) denies a `window.open(externalUrl)` and delegates
   * it to the OS browser. The single enforcement point keeps the three factories
   * from drifting — previously the net was wired per-call-site in `index.ts`, so
   * a window created by any other path came up net-less.
   *
   * `setWindowOpenHandler` must be registered BEFORE the window's `loadURL`, so
   * every caller invokes this immediately after `createWindow`.
   *
   * Guarded on the grouped `safetyNet` dep: unit harnesses that don't exercise
   * the net omit it (their webContents fake has no `setWindowOpenHandler`), so
   * the net stays off for them; production + the factory-net tests wire it.
   */
  private attachSafetyNet(
    webContents: BrowserWindowLike['webContents'],
    editorOrigin: string,
    assetRoot: string,
  ): void {
    const net = this.deps.safetyNet;
    if (!net) return;
    attachAssetSafetyNet(webContents, {
      editorOrigin,
      openExternal: net.openExternal,
      openAsset: (relPath) => net.openAsset(assetRoot, relPath),
    });
  }

  async createProjectWindow(opts: CreateProjectWindowOpts): Promise<ProjectContext> {
    const canonicalKey = this.canonicalizeKey(resolve(opts.projectPath));
    // In-flight reservation (mirrors `createEphemeralWindow`): the inner
    // method's dedup only matches a COMPLETED window, so a concurrent second
    // open of the same project — session restore collapsing two loose files
    // into one project, or a restore racing a deep-link — would spawn a
    // duplicate. Registered synchronously so a concurrent caller observes it.
    const inFlight = this.projectPendingByPath.get(canonicalKey);
    if (inFlight) {
      const ctx = await inFlight;
      if (ctx.window.isDestroyed?.() !== true) {
        this.bringToFront(ctx.window);
        return ctx;
      }
      // The in-flight open's window was torn down before we observed it; its
      // `finally` cleared the reservation, so the fresh attempt starts clean.
    }
    // `spawnProjectWindow`'s synchronous prefix (the `tryAttachExistingServer`
    // sync gates) still runs synchronously as `work` is created — no await
    // precedes it here — preserving the spawn-path tests' `fire('ready')`
    // ordering.
    const work = (async (): Promise<ProjectContext> => {
      try {
        return await this.spawnProjectWindow(opts);
      } finally {
        this.projectPendingByPath.delete(canonicalKey);
      }
    })();
    this.projectPendingByPath.set(canonicalKey, work);
    return work;
  }

  /**
   * The uncached body of `createProjectWindow` — never call directly (it has no
   * in-flight reservation, so two direct calls would race). Keeps its own
   * COMPLETED-window fast-path for sequential re-opens.
   */
  private async spawnProjectWindow(opts: CreateProjectWindowOpts): Promise<ProjectContext> {
    const projectPath = resolve(opts.projectPath);
    const canonicalKey = this.canonicalizeKey(projectPath);
    const existing = this.windowsByPath.get(canonicalKey);
    if (existing) {
      // Focus existing rather than spawn a duplicate. Guard against a
      // destroyed BrowserWindow: there's a window of ~seconds between
      // `window.on('closed')` firing (which destroys the native object)
      // and `utility.on('exit')` firing (which clears the map entry,
      // gated by `windowLifecycleBound` shutdown completing). A click in
      // that gap would call `.focus()` on a destroyed object and throw
      // `TypeError: Object has been destroyed`. Treat destroyed entries
      // as stale and proceed to spawn-fresh.
      if (existing.window.isDestroyed?.() !== true) {
        this.bringToFront(existing.window);
        return existing;
      }
      this.deps.log?.warn(
        { canonicalKey },
        '[window-manager] stale destroyed-window entry — clearing and re-creating',
      );
      this.windowsByPath.delete(canonicalKey);
    }
    const projectName = basename(projectPath);

    const lockDir = getLocalDir(projectPath);

    // Attach branch — if a live same-host server is already listening on
    // this contentDir (CLI sibling, another Electron instance that we
    // want to share with, etc.), skip the utility spawn entirely and just
    // point the renderer at the existing collab URL. `runClean` is also
    // skipped here because an attachable lock is by definition NOT stale.
    // Two-step: synchronous metadata gates first, then an async WS probe
    // only when the metadata gates passed. Keeping the no-lock fall-
    // through purely synchronous matters — an unconditional `await` here
    // would inject a microtask that re-orders the existing spawn-path
    // tests' synchronous `fire('ready')` against the utility fork.
    const candidate = this.tryAttachExistingServer(lockDir);
    const attached =
      candidate !== null && (await this.probeAttachableLock(candidate)) ? candidate : null;
    // Two reasons to terminate an attachable foreign server and spawn our own
    // instead of attaching. Both are SILENT (no toast) and both fall through to
    // the `runClean` + fresh-spawn sequence below; on termination failure both
    // fall back to attaching, so a project is never left window-less.
    //
    //   1. Dev-only reclaim (`reclaimForeignServerInDev`): a dev session runs
    //      its working-tree build against a project even when a prior packaged
    //      run / CLI / another instance left a server behind. The routine
    //      restart of a rebuild is not worth a notice.
    //   2. Packaged upgrade reconcile (`isFirstLaunchAfterUpgrade`): the first
    //      launch after an app update, where a version-mismatched server that
    //      survived the pre-install teardown is a stale build. We restart it to
    //      the app's version rather than attaching to the stale build and
    //      prompting. No toast — the "Updated to Version X" whats-new notice
    //      already tells the user the app updated.
    //
    // `spawnedDetachedPids` is empty under the dev utility-fork path, so the
    // foreign guard reads as "always foreign" there — but it stays load-bearing
    // for the packaged path (a same-session reopen re-attaches to OUR OWN
    // server, which must NOT be reclaimed).
    if (attached) {
      const isForeign = this.spawnedDetachedPids.get(canonicalKey) !== attached.pid;
      let reclaimed = false;
      if (this.deps.reclaimForeignServerInDev === true && isForeign) {
        const term = await this.terminateServerByPid(lockDir, attached.pid);
        if (term.ok) {
          this.deps.log?.info(
            {
              event: 'desktop-dev-reclaim',
              outcome: 'terminated',
              escalated: term.escalated,
              pid: attached.pid,
              projectPath,
            },
            '[window-manager] dev-mode reclaimed foreign server; spawning fresh own-build server',
          );
          reclaimed = true;
        } else {
          this.deps.log?.warn(
            {
              event: 'desktop-dev-reclaim',
              outcome: term.reason,
              pid: attached.pid,
              projectPath,
            },
            '[window-manager] dev-mode reclaim could not terminate the foreign server; attaching to it instead',
          );
        }
      }
      // Packaged upgrade reconcile — only if the dev path didn't already handle
      // it, and only when the survivor is a genuinely different build. Gating on
      // a real drift (any direction) means a same-version server we'd share is
      // left untouched, so we never needlessly bounce a project on upgrade.
      if (!reclaimed && this.deps.isFirstLaunchAfterUpgrade?.() === true && isForeign) {
        const selfProtocol = this.deps.selfProtocolVersion;
        const selfRuntime = this.deps.selfRuntimeVersion;
        if (selfProtocol !== undefined && selfRuntime !== undefined) {
          const drift = classifyServerVersion(
            { protocolVersion: attached.protocolVersion, runtimeVersion: attached.runtimeVersion },
            { protocolVersion: selfProtocol, runtimeVersion: selfRuntime },
          );
          if (drift.relation === 'older' || drift.relation === 'newer') {
            const term = await this.terminateServerByPid(lockDir, attached.pid);
            if (term.ok) {
              this.deps.log?.info(
                {
                  event: 'desktop-upgrade-reconcile',
                  outcome: 'terminated',
                  escalated: term.escalated,
                  relation: drift.relation,
                  pid: attached.pid,
                  projectPath,
                },
                '[window-manager] first launch after upgrade — auto-terminated pre-upgrade server; spawning fresh own-version server',
              );
              reclaimed = true;
            } else {
              this.deps.log?.warn(
                {
                  event: 'desktop-upgrade-reconcile',
                  outcome: term.reason,
                  relation: drift.relation,
                  pid: attached.pid,
                  projectPath,
                },
                '[window-manager] upgrade auto-terminate failed; attaching to the pre-upgrade server (the manual version-drift prompt still offers a restart)',
              );
            }
          }
        }
      }
      if (!reclaimed) {
        return this.attachToExistingServer({
          projectPath,
          canonicalKey,
          projectName,
          lock: attached,
          pendingDeepLinkTarget: opts.pendingDeepLinkTarget,
          pendingBranch: opts.pendingBranch,
          pendingMultiCandidate: opts.pendingMultiCandidate,
          pendingTargetMissing: opts.pendingTargetMissing,
          pendingShareBranchSwitch: opts.pendingShareBranchSwitch,
          pendingServerRestartedToast: opts.pendingServerRestartedToast,
          freshlyCreated: opts.freshlyCreated,
        });
      }
      // Reclaimed: the terminated server's (possibly stale) lock is cleared by
      // the `runClean` step below before the fresh spawn — same sequence the
      // user-initiated `restartAttachedServer` path relies on.
    }

    if (this.deps.runClean) {
      try {
        await this.deps.runClean({ lockDir });
      } catch (err) {
        this.deps.log?.warn({ err, lockDir }, 'runClean failed; proceeding to spawn server');
      }
    }

    // Detached-spawn branch — preferred when wired (production Electron).
    // Spawns the OK server as a fully-detached child of `process.execPath`
    // under `ELECTRON_RUN_AS_NODE=1`, waits for the server.lock to appear
    // with a valid port, then delegates to `attachToExistingServer` so the
    // window enters attach mode against the server we just bootstrapped.
    // The server survives Electron parent exit — closing the window or
    // quitting the app does not affect it.
    if (this.deps.spawnDetachedServer) {
      const reactShellDistDir = dirname(this.deps.rendererEntryPath);
      const handle = await this.deps.spawnDetachedServer({
        contentDir: projectPath,
        reactShellDistDir,
      });
      this.spawnedDetachedPids.set(canonicalKey, handle.pid);
      const POLL_DEADLINE_MS =
        this.deps.spawnLockPollDeadlineMs ?? DEFAULT_SPAWN_STARTUP_DEADLINE_MS;
      const { lock, waitedDeadlineMs } = await this.pollServerLock(
        lockDir,
        POLL_DEADLINE_MS,
        handle,
        this.deps.spawnLockProgressDeadlineMs,
      );
      if (lock === null) {
        // Both sampled BEFORE the SIGTERM below — afterwards they would be
        // observing our own kill and would report a merely-slow child as
        // having crashed. `childExited` is `undefined` when there is no probe.
        const childExited = this.deps.isProcessAlive
          ? !this.deps.isProcessAlive(handle.pid)
          : undefined;
        const childExit = handle.readExit?.() ?? null;
        // The detached spawn is `.unref()`ed, so a server that started but
        // failed to bind a port (or stalled before writing its lock) will
        // continue running as an orphan after we throw. Idle-shutdown may
        // not have initialized in this failure window, leaving the process
        // with no reaper. SIGTERM it before deleting from the tracking map
        // so the failure is bounded.
        try {
          this.deps.killProbe(handle.pid, 'SIGTERM');
        } catch (signalErr) {
          // ESRCH = already exited (race between spawn failure and our
          // poll giving up); anything else gets a warn-level breadcrumb so
          // a stuck orphan after spawn-timeout is grep-able.
          const code = (signalErr as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') {
            this.deps.log?.warn(
              {
                event: 'desktop-spawn-orphan-sigterm-failed',
                err: signalErr,
                code,
                pid: handle.pid,
                projectPath,
              },
              '[window-manager] SIGTERM on orphan after spawn-lock-timeout failed',
            );
          }
        }
        this.spawnedDetachedPids.delete(canonicalKey);
        // Surface the child's own account of the failure (exit code/signal,
        // plus its captured stderr) rather than only the deadline.
        throw this.buildSpawnFailureError({
          pid: handle.pid,
          exit: childExit,
          lockDir,
          deadlineMs: waitedDeadlineMs,
          spawnLabel: 'spawn',
          childExited,
        });
      }
      // A lock our child did not write is an UNVERIFIED claim, and the readiness
      // this branch is about to declare rests on it. `pollServerLock` accepts a
      // foreign holder deliberately — a concurrent starter that won the acquire
      // is a real server worth sharing, which the losing-child path depends on —
      // but a STALE holder passes every metadata gate that acceptance rests on:
      // right host, valid pid, non-draining, real port, and (because EPERM reads
      // as alive) a liveness check it cannot fail. Only asking the port
      // separates the two, and `spawnProjectWindow`'s attach gate already asks
      // it about this very lock. Not asking here is how one field log recorded
      // both verdicts on the same port 2 ms apart — `desktop-attach-refused`
      // with `reason: 'ws-upgrade-failed'`, then this line calling it ready —
      // and the window opened onto a port answering nothing.
      //
      // Our OWN child is exempt: we watched it come up, so a probe would buy no
      // signal and cost every cold start its timeout.
      const adoptedForeignLock = lock.pid !== handle.pid;
      // Two doors lead into `attachToExistingServer`, and gating only the direct
      // one leaves the other open. `pollServerLock` admits on `lock.port > 0` —
      // a RELATIONAL compare, so `'42117' > 0` coerces true — and this branch
      // then attaches whatever it returned. A lock we cannot carry has to be
      // refused at both doors or the stricter predicate is decoration.
      const unusableLock = !lockIsAttachable(lock);
      if (unusableLock || (adoptedForeignLock && !(await this.probeForeignLockWithGrace(lock)))) {
        // Our child may still be alive here (it can lose the publish race
        // without losing the acquire), and it is `.unref()`ed, so refusing the
        // holder without reaping it leaks an orphan with no parent to reap it —
        // the same hazard the lock-timeout branch above handles, for the same
        // reason. ESRCH just means it already exited.
        const childExited = this.deps.isProcessAlive
          ? !this.deps.isProcessAlive(handle.pid)
          : undefined;
        const childExit = handle.readExit?.() ?? null;
        try {
          this.deps.killProbe(handle.pid, 'SIGTERM');
        } catch (signalErr) {
          const code = (signalErr as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') {
            this.deps.log?.warn(
              {
                event: 'desktop-spawn-orphan-sigterm-failed',
                err: signalErr,
                code,
                pid: handle.pid,
                projectPath,
              },
              '[window-manager] SIGTERM on orphan after refusing a stale lock failed',
            );
          }
        }
        this.spawnedDetachedPids.delete(canonicalKey);
        this.deps.log?.warn(
          {
            event: 'desktop-server-spawn-refused-stale-lock',
            reason: unusableLock ? 'lock-not-attachable' : 'holder-not-serving',
            pid: handle.pid,
            lockPid: lock.pid,
            port: lock.port,
            // `port` alone cannot name which shape refused this. Under pino's
            // JSON semantics `undefined` drops the key and `Infinity` becomes
            // `null`, so a bundle showing `"port": null` cannot distinguish a
            // writer that set nothing from one that computed `Infinity` — two
            // different upstream bugs. These two survive serialization.
            portType: typeof lock.port,
            rawPort: String(lock.port),
            lockDir,
            projectPath,
          },
          '[window-manager] refusing to attach the spawn to a lock we cannot use',
        );
        // Its OWN error kind, deliberately not `buildSpawnFailureError`. That
        // one narrates a deadline and the child's exit, and nothing here is a
        // deadline: `pollServerLock` returned on its first read, so reporting
        // the tier that was never served would blame a 15 s timeout that did
        // not elapse, on our own healthy child's pid, and never mention the
        // holder. It also would not reach the remedy — the failed-open dialog
        // gates Stop Server & Retry on the kind, so a refusal that wants that
        // button has to say what it actually is.
        // `||` short-circuits, so on the unusable-lock arm the holder was never
        // dialed. Reporting "is not serving" there states a probe result that
        // does not exist, and the failed-open dialog quotes this message
        // verbatim — the user would consent to stopping a process on the claim
        // it is already inert. The holder framing has to move too: `unusableLock`
        // is deliberately not exempted for our own child the way the probe is,
        // so "another process" can be our own healthy spawn.
        const holder = adoptedForeignLock
          ? `Another process (pid ${lock.pid})`
          : `The server OpenKnowledge just started (pid ${lock.pid})`;
        throw Object.assign(
          new Error(
            unusableLock
              ? `${holder} holds this project's server lock, but the lock does not name a port ` +
                  `OpenKnowledge can keep a connection open on (${String(lock.port)}).`
              : `${holder} holds this project's server lock but is not serving on port ${lock.port}.`,
          ),
          {
            name: 'StaleLockHolderError',
            kind: 'stale-lock-holder' as const,
            reason: unusableLock
              ? ('lock-not-attachable' as const)
              : ('holder-not-serving' as const),
            // The unusable arm is not exempted for our own spawn the way the
            // probe is, so the holder here can be the child this method just
            // SIGTERMed. Asking the user whether they still need a process we
            // killed for them, from the request they just made, has no answer
            // they could act on — the dialog drops that clause when this is set.
            holderIsOwnChild: !adoptedForeignLock,
            holderPid: lock.pid,
            holderPort: lock.port,
            pid: handle.pid,
            childExited,
            exitCode: childExit?.code ?? null,
            exitSignal: childExit?.signal ?? null,
          },
        );
      }
      this.deps.log?.info(
        {
          event: 'desktop-server-spawned-detached',
          pid: handle.pid,
          // `pid` and `port` come from different sources — our child handle and
          // whoever holds the lock. Recording `lockPid` and how the claim was
          // established keeps the pair auditable: without them this record
          // cannot distinguish "our child came up" from "we adopted a
          // stranger's lock", which is precisely the confusion it caused.
          lockPid: lock.pid,
          readiness: adoptedForeignLock ? 'foreign-lock-probe-verified' : 'own-child',
          port: lock.port,
          lockDir,
        },
        '[window-manager] detached server ready',
      );
      // Startup waterfall: the detached server's lock is now readable — carry
      // its `startedAt` (clock-skew term) + `apiOrigin` (server-info fetch).
      this.deps.startup?.markServerLockReady?.({
        startedAt: lock.startedAt,
        apiOrigin: lockApiOrigin(lock),
      });
      return this.attachToExistingServer({
        projectPath,
        canonicalKey,
        projectName,
        lock,
        pendingDeepLinkTarget: opts.pendingDeepLinkTarget,
        pendingBranch: opts.pendingBranch,
        pendingMultiCandidate: opts.pendingMultiCandidate,
        pendingTargetMissing: opts.pendingTargetMissing,
        pendingShareBranchSwitch: opts.pendingShareBranchSwitch,
        pendingServerRestartedToast: opts.pendingServerRestartedToast,
        freshlyCreated: opts.freshlyCreated,
      });
    }

    // Utility-fork branch — Electron dev runtime and the test harness.
    // Init timeout: if utility has not posted `ready` or `error` within this
    // window, reject so `createProjectWindow` doesn't hang forever. A spawn-
    // phase hang is observable in the wild (bootServer throws synchronously
    // on a bad path, parent-death poll beats the `ready` handshake, utility
    // crashes before posting, etc.).
    const INIT_TIMEOUT_MS = this.deps.utilityInitTimeoutMs ?? 15_000;

    // Single-attempt fork. With `tryAttachExistingServer` now accepting
    // both `interactive` and `mcp-spawned` locks (precedent: kind is
    // provenance-only — every bootServer exposes the same HTTP+WS surface),
    // a live attachable holder is reached via the attach-mode path above.
    // The narrow race window where the holder has written `port=0` but not
    // yet bound surfaces here as `ServerLockCollisionError`; the user
    // retries opening the project and the second attempt attaches cleanly.
    const utility = this.deps.forkUtility(
      this.deps.utilityEntryPath,
      [`--ok-lock-dir-b64=${Buffer.from(lockDir, 'utf8').toString('base64url')}`],
      {
        windowLifecycleBound: true,
      },
    );
    const utilityRef = utility;
    const ready = new Promise<{ port: number; apiOrigin: string }>((resolveReady, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        utilityRef.removeListener?.('message', onMessage);
        utilityRef.removeListener?.('exit', onExit);
        fn();
      };
      const onMessage = (msg: unknown) => {
        const m = msg as {
          type?: string;
          port?: number;
          apiOrigin?: string;
          message?: string;
          kind?: string;
          existingLock?: ServerLockMetadataLike;
        };
        if (m.type === 'ready' && typeof m.port === 'number' && typeof m.apiOrigin === 'string') {
          const p = m.port;
          const o = m.apiOrigin;
          settle(() => resolveReady({ port: p, apiOrigin: o }));
        } else if (m.type === 'error') {
          const richError = Object.assign(new Error(m.message ?? 'utility init failed'), {
            name: m.kind === 'lock-collision' ? 'LockCollisionError' : 'UtilityInitError',
            kind: m.kind,
            existingLock: m.existingLock,
          });
          settle(() => reject(richError));
        }
      };
      const onExit = (code: number | null) => {
        settle(() => reject(new Error(`utility exited before ready (code=${code})`)));
      };
      utilityRef.on('message', onMessage);
      utilityRef.on('exit', onExit);

      this.deps.setTimeout(() => {
        settle(() => reject(new Error(`utility init timed out after ${INIT_TIMEOUT_MS}ms`)));
      }, INIT_TIMEOUT_MS);
    });

    // Derive the React-shell dist directory from the renderer entry path
    // — only meaningful in PACKAGED builds where electron-builder copies
    // the bundled SPA to `<Resources>/app/`. In dev (`rendererDevUrl`
    // set), `rendererEntryPath` resolves to `<out>/renderer/index.html`
    // — a path electron-vite never writes (vite dev server streams the
    // renderer over `localhost:5173`; `out/` only contains `main/` +
    // `preload/`). Forwarding the non-existent dir to the utility's
    // sirv mount would scandir-ENOENT, reject `createProjectWindow`,
    // and dump the user back on Navigator. Omit the field in dev — the
    // BrowserWindow loads `rendererDevUrl` directly so the utility has
    // no shell to serve anyway.
    const reactShellDistDir = this.deps.rendererDevUrl
      ? null
      : dirname(this.deps.rendererEntryPath);

    utility.postMessage({
      type: 'init',
      opts: {
        contentDir: projectPath,
        projectDir: projectPath,
        port: 0,
        // Numeric IPv4 loopback, NOT `localhost`. macOS resolves `localhost`
        // IPv6-first, so `listen(port, 'localhost')` binds `[::1]` only —
        // while every dialer (the MCP shim, keepalive WS, `ok ps`) uses
        // `DEFAULT_SERVER_HOST`, which is numeric IPv4. The mismatch made a
        // dev-launched project's server unreachable to its own MCP: the
        // keepalive WS errored and reconnected forever while the window
        // itself worked fine. `ok start` already resolves to this constant,
        // so this keeps the dev boot path on the same address as every other.
        host: DEFAULT_SERVER_HOST,
        didEnsureGit: opts.didEnsureGit === true,
        consentVersion: opts.consentVersion ?? 1,
        // Conditional spread (matches `localOpCliArgs` below) keeps the
        // omit-when-absent shape that the strict-equality init-payload
        // tests rely on.
        ...(reactShellDistDir !== null ? { reactShellDistDir } : {}),
        ...(opts.localOpCliArgs ? { localOpCliArgs: opts.localOpCliArgs } : {}),
      },
    });

    const { port, apiOrigin } = await ready;
    // Startup waterfall (dev / test utility-fork path): the server posted
    // `ready`, so its lock is bound. The fork handshake carries no `startedAt`
    // (clock-skew term omitted on this path), but the `apiOrigin` lets main
    // fetch the server boot timings.
    this.deps.startup?.markServerLockReady?.({ apiOrigin });

    // Persistent post-init message listener. The init-phase listener above was
    // detached by `settle()` once `ready`/`error` resolved; this observes every
    // subsequent message so main-side consumers (e.g., debug-ipc relay's
    // correlation map) can route replies. No-op when `onUtilityMessage` is unset.
    if (this.deps.onUtilityMessage) {
      const onMessage = this.deps.onUtilityMessage;
      utility.on('message', (msg) => onMessage(msg));
    }

    // Post-exit liveness probe — covers the case where
    // utilityProcess.on('exit') fires but the pid is still alive (see VS Code
    // Issue #194477). The init-phase exit handler above rejects `ready` when
    // exit fires early; both listeners coexist on the same event and observe
    // independently.
    utility.on('exit', (code) => {
      this.deps.log?.info({ pid: utility.pid, code }, 'utility exited');
      // Persist the exit for bug-report diagnosis before any teardown — the
      // main process observes this death even when the server (SIGKILL'd /
      // OOM-killed) could not report it itself.
      this.deps.recordServerExit?.({ lockDir, pid: utility.pid ?? null, code });
      this.windowsByPath.delete(canonicalKey);
      // Reject any in-flight debug-IPC requests bound to this utility so
      // pending entries don't linger for the full timeout window after a
      // crash. Same utility reference used by `onUtilityMessage`, enabling
      // identity-match in the consumer's pending Map.
      this.deps.onUtilityExit?.(utility);
      const pid = utility.pid;
      if (typeof pid === 'number') {
        this.deps.setTimeout(() => {
          try {
            this.deps.killProbe(pid, 0);
            this.deps.log?.warn(
              { pid },
              'utility pid still alive 1s after exit event — sending SIGTERM',
            );
            this.deps.killProbe(pid, 'SIGTERM');
          } catch {
            // Process truly gone — happy path.
          }
        }, 1000);
      }
    });

    const additionalArguments = [
      `--ok-collab-url=ws://localhost:${port}/collab`,
      `--ok-api-origin=${apiOrigin}`,
      `--ok-project-path=${projectPath}`,
      `--ok-project-name=${projectName}`,
      `--ok-mode=editor`,
      `--ok-app-version=${this.deps.appVersion}`,
      ...instanceLabelArgs(),
      // Startup instrumentation (Plan A): carry main's `ok.app-startup`
      // traceparent so the renderer parents its startup span into the launch
      // trace. Appended only when present (OTel enabled in main).
      ...(this.deps.startup?.traceparent !== undefined
        ? [`--ok-startup-traceparent=${this.deps.startup.traceparent}`]
        : []),
      // Appended only when set, so every other entry point omits it (preload
      // coerces absent → false).
      ...(opts.freshlyCreated ? ['--ok-fresh-create=1'] : []),
    ];
    const window = this.deps.createWindow({
      additionalArguments,
      title: formatEditorTitle(projectName),
      projectPath,
    });
    this.deps.startup?.markWindowCreated?.();
    this.attachSafetyNet(window.webContents, apiOrigin, projectPath);

    // Deep-link gate — register `dom-ready` listener BEFORE awaiting `loadURL`.
    // A synchronous send from url-scheme.ts's routeUrl would work today only
    // because main.tsx's subscriber install is synchronous at module-init;
    // any future refactor (dynamic import, Suspense boundary, React effect)
    // would silently drop the event.
    if (opts.pendingDeepLinkTarget) {
      const doc = opts.pendingDeepLinkTarget.path;
      const kind = opts.pendingDeepLinkTarget.kind;
      const branch = opts.pendingBranch ?? null;
      const multiCandidate = opts.pendingMultiCandidate === true;
      registerPendingDelivery(window.webContents, 'ok:deep-link', {
        doc,
        kind,
        branch,
        multiCandidate,
        ...(opts.pendingDeepLinkTarget.repositoryPath === undefined
          ? {}
          : { repositoryPath: opts.pendingDeepLinkTarget.repositoryPath }),
        ...(opts.pendingDeepLinkTarget.contentRootDepth === undefined
          ? {}
          : { contentRootDepth: opts.pendingDeepLinkTarget.contentRootDepth }),
        // Only carry the flag when set — keeps the common (present) case's
        // payload identical to the pre-gate shape.
        ...(opts.pendingTargetMissing === true ? { targetMissing: true } : {}),
      });
    }

    // Share-receive branch-switch gate — symmetric with `pendingDeepLinkTarget`.
    // The renderer's share-receive listener installs at module-init; registering
    // the readiness-gated delivery BEFORE `await loadURL` is what makes the
    // cold-start first-click work for the `fallback` outcome (project on a
    // different branch).
    if (opts.pendingShareBranchSwitch) {
      const branchSwitch = opts.pendingShareBranchSwitch;
      registerPendingDelivery(window.webContents, 'ok:share:received', {
        kind: 'project-branch-switch' as const,
        share: branchSwitch.share,
        projectPath: branchSwitch.projectPath,
        currentBranch: branchSwitch.currentBranch,
      });
    }

    // (No "started a fresh server" notice here: the dev reclaim path and the
    // packaged upgrade reconcile both terminate + respawn silently, so no
    // server-lifecycle toast is delivered on this dev/test-only utility-fork
    // branch.)

    // Defer OS-level window display until both first-paint AND chrome-theme
    // signals arrive — `show: false` in DEFAULT_WIN_OPTS hides the native
    // window. The dual-signal gate (`ready-to-show` + `ok:theme:applied`)
    // eliminates the cold-launch frame where chrome could reflect a stale
    // `nativeTheme.themeSource`. Registration must precede `await loadURL`
    // for the same reason `dom-ready` does: events can fire before the await
    // resolves on a fast load. A 5 s safety timeout shows the window even if
    // either signal stalls — see show-gate.ts for the structured warn
    // emitted on timeout.
    const disposeShowGate = this.deps.showGate.register(window, { kind: 'editor' });

    const context: ProjectContext = {
      projectPath,
      canonicalKey,
      projectName,
      port,
      apiOrigin,
      window,
      utility,
      ownsServer: true,
    };
    const releaseLoadingContext = this.publishLoadingContext(context);
    try {
      if (this.deps.rendererDevUrl) {
        await window.loadURL(this.deps.rendererDevUrl);
      } else {
        await window.loadFile(this.deps.rendererEntryPath);
      }
      this.deps.startup?.markLoadUrlResolved?.();

      window.on('closed', () => {
        // Drop any stale show-gate state — a window destroyed before either
        // signal arrives must not hold a slot in the registry's Map.
        disposeShowGate();
        // Guard against detached IPC port — the utility may have already exited
        // (e.g. crash, parent-death poll beat us) in which case `postMessage`
        // throws ERR_IPC_CHANNEL_CLOSED. The utility's shutdown drain +
        // parentLifecycleBound takes care of the forked process regardless;
        // windowsByPath.delete fires from the utility's exit event above.
        try {
          utility.postMessage({ type: 'shutdown' });
        } catch (err) {
          this.deps.log?.warn(
            { err, projectPath },
            'utility shutdown IPC failed on window close (likely already exited)',
          );
        }
      });

      this.windowsByPath.set(canonicalKey, context);
    } finally {
      releaseLoadingContext();
    }
    return context;
  }

  /**
   * Open (or focus) an ephemeral single-file editing session for a no-project
   * file (`ok <file>`). Distinct from `createProjectWindow` in ways that make a
   * dedicated method cleaner than threading an `ephemeral` flag through that
   * 450-line path:
   *   - **Dedup on the canonical FILE path, gated on SERVER liveness**: a second
   *     `ok <samefile>` focuses the existing window rather than spawning a second
   *     server on the same inode (which would clobber the file) — but ONLY when
   *     that window's detached server is still alive. A dead cached session is
   *     reaped and re-spawned instead of re-served (see `isEphemeralServerAlive`).
   *     The dedup check runs BEFORE any temp-dir creation so a focus never leaks
   *     a throwaway dir.
   *   - **Slim single-file boot** in a throwaway temp `projectDir` (git + MCP
   *     off, content scoped to the one doc): no `.ok/` lands in the user's dir.
   *   - **Deterministic teardown** on window-close: a detached server would
   *     otherwise survive the close. The `'closed'`
   *     handler terminates the pid then removes the temp dir, sequentially.
   *   - **Server-liveness exit-watch**: because the server is detached, it can
   *     die while the window stays open; a per-session poll (armed when the
   *     `setInterval` dep is wired) reaps the dead server's temp dir. It leaves
   *     the window itself open — the dedup gate above handles the next re-open.
   *
   * Requires the ephemeral deps (`createEphemeralProjectDir`,
   * `spawnDetachedServer`, `removeDir`) to be wired — there is no fallback for an
   * ephemeral session, so an unwired dep is a programming error, not a
   * back-compat path.
   */
  async createEphemeralWindow(opts: {
    /** `realpath`-canonical path of the file — the dedup key + write-back target. */
    canonicalFilePath: string;
    /** The file's real parent directory — the ephemeral session's contentDir. */
    contentDir: string;
    /** Ext-less doc name (`notes.md` → `notes`) — the editor's deep-link target. */
    docName: string;
  }): Promise<ProjectContext> {
    // Dedup BEFORE creating a temp dir (constraint: a focus must not leak a
    // throwaway dir). Key on the canonical file path so two `ok <samefile>`
    // opens converge on one window + one server.
    const canonicalKey = this.canonicalizeKey(opts.canonicalFilePath);
    const existing = this.windowsByPath.get(canonicalKey);
    if (existing) {
      const windowAlive = existing.window.isDestroyed?.() !== true;
      // Dedup only onto a session that is BOTH window-alive AND server-alive. An
      // ephemeral server is detached and can die while its window stays open; the
      // pre-fix check trusted window liveness alone and re-served a dead
      // `apiOrigin`, so `ok open <file>` "succeeded" with no live session.
      if (windowAlive && this.isEphemeralServerAlive(existing)) {
        this.bringToFront(existing.window);
        // Converge: retire any other (dead-server) window left open for this
        // file; keep the live `existing` one.
        this.retireStaleWindowsForFile(canonicalKey, existing.window);
        return existing;
      }
      this.deps.log?.warn(
        {
          event: 'desktop-ephemeral-stale-entry',
          canonicalKey,
          windowAlive,
          pid: existing.ephemeral?.pid,
          apiOrigin: existing.apiOrigin,
          lockDir: existing.ephemeral?.lockDir,
        },
        windowAlive
          ? '[window-manager] ephemeral entry has a dead server — clearing and re-spawning'
          : '[window-manager] stale destroyed ephemeral entry — clearing and re-creating',
      );
      this.windowsByPath.delete(canonicalKey);
      // The stale session's keepalive (if any) is now pointing at a lockDir the
      // teardown below removes — close it here so it does not reconnect-loop for
      // the stale window's remaining lifetime (its guarded `'closed'` teardown
      // won't run once this re-open takes the slot). No-op when none was opened.
      this.closeKeepalive(canonicalKey);
      // Reap the dead session's temp dir + (already-dead) pid only when the
      // window is still open here. A destroyed window already ran its `'closed'`
      // teardown; teardown is idempotent, but skipping the redundant SIGTERM/rm
      // keeps the destroyed-window path single-pass, as before.
      //
      // This branch only reaps the dead SERVER + temp dir; the stale WINDOW is
      // not closed here. Convergence to a single window happens later in this same
      // flow: once the fresh server is live, `retireStaleWindowsForFile` (at the
      // end of `spawnEphemeralWindow`) closes every other window for the file,
      // including this one. Splitting it that way keeps the "close the old window"
      // step behind a live replacement (recreate-then-close, no flash), matching
      // `restartAttachedServer`'s ordering — closing here, before the replacement
      // exists, would flash an empty gap and yank a window the user may still be
      // reading with nothing yet to replace it.
      if (windowAlive && existing.ephemeral) {
        void this.teardownEphemeralSession(existing.ephemeral);
      }
    }

    // A same-file open already in flight (mid spawn/load) → await it and focus
    // its window rather than spawning a second server on the same inode. See
    // `ephemeralPendingByPath`. The reservation is registered synchronously (no
    // await precedes the `set` below) so a concurrent second caller observes it.
    const inFlight = this.ephemeralPendingByPath.get(canonicalKey);
    if (inFlight) {
      const ctx = await inFlight;
      if (ctx.window.isDestroyed?.() !== true) {
        this.bringToFront(ctx.window);
        return ctx;
      }
      // The in-flight open's window was torn down before we observed it; the
      // wrapper's `finally` clears the reservation before `work` settles, so a
      // fresh attempt won't re-enter this branch.
      return this.createEphemeralWindow(opts);
    }

    const work = (async (): Promise<ProjectContext> => {
      try {
        return await this.spawnEphemeralWindow(opts, canonicalKey);
      } finally {
        // Clear before `work` settles — see `ephemeralPendingByPath`. Runs on
        // success AND failure; a failed open leaves no `windowsByPath` entry,
        // so the next open starts fresh.
        this.ephemeralPendingByPath.delete(canonicalKey);
      }
    })();
    this.ephemeralPendingByPath.set(canonicalKey, work);
    return work;
  }

  /**
   * The uncached body of `createEphemeralWindow` — spawn the detached server,
   * await its lock, build + load the window, register it in `windowsByPath`.
   * Never call directly: go through `createEphemeralWindow`, which holds the
   * `windowsByPath` dedup + the `ephemeralPendingByPath` in-flight reservation
   * (this method has neither, so two direct calls would race).
   */
  private async spawnEphemeralWindow(
    opts: { canonicalFilePath: string; contentDir: string; docName: string },
    canonicalKey: string,
  ): Promise<ProjectContext> {
    const { createEphemeralProjectDir, spawnDetachedServer, removeDir } = this.deps;
    if (!createEphemeralProjectDir || !spawnDetachedServer || !removeDir) {
      throw new Error(
        'createEphemeralWindow requires createEphemeralProjectDir + spawnDetachedServer + removeDir deps to be wired',
      );
    }

    const projectName = basename(opts.canonicalFilePath);

    // Throwaway temp projectDir (synthesized `.ok/config.yml`). The file's real
    // parent is the contentDir, passed distinctly so the spawn keeps `.ok/`
    // state out of the user's directory.
    const tempProjectDir = createEphemeralProjectDir(opts.contentDir);
    const lockDir = getLocalDir(tempProjectDir);

    const reactShellDistDir = dirname(this.deps.rendererEntryPath);
    // Derived from the dep rather than hand-written, so the handle keeps every
    // field the spawn actually returns (the exit record among them) instead of
    // being silently narrowed away by a stale local annotation.
    let handle: Awaited<ReturnType<NonNullable<WindowManagerDeps['spawnDetachedServer']>>>;
    try {
      handle = await spawnDetachedServer({
        contentDir: opts.contentDir,
        reactShellDistDir,
        singleFile: opts.canonicalFilePath,
        projectDir: tempProjectDir,
      });
    } catch (err) {
      // Spawn failed before the session existed — remove the temp dir we
      // created (no server to stop) and rethrow so the caller can surface it.
      await removeDir(tempProjectDir).catch(() => {});
      throw err;
    }

    const POLL_DEADLINE_MS = this.deps.spawnLockPollDeadlineMs ?? DEFAULT_SPAWN_STARTUP_DEADLINE_MS;
    const { lock, waitedDeadlineMs } = await this.pollServerLock(
      lockDir,
      POLL_DEADLINE_MS,
      handle,
      this.deps.spawnLockProgressDeadlineMs,
    );
    if (lock === null) {
      // Both sampled BEFORE the SIGTERM below — see the project-open path.
      // This path additionally awaits `removeDir` before throwing, so a
      // re-read after the kill would very likely observe it.
      const childExited = this.deps.isProcessAlive
        ? !this.deps.isProcessAlive(handle.pid)
        : undefined;
      const childExit = handle.readExit?.() ?? null;
      // Server never bound — SIGTERM the orphan (the spawn is `.unref()`ed, so a
      // half-started server would otherwise leak), remove the temp dir, and
      // surface the captured stderr (same shape as the project spawn-timeout).
      try {
        this.deps.killProbe(handle.pid, 'SIGTERM');
      } catch (signalErr) {
        const code = (signalErr as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') {
          this.deps.log?.warn(
            {
              event: 'desktop-ephemeral-spawn-orphan-sigterm-failed',
              err: signalErr,
              code,
              pid: handle.pid,
            },
            '[window-manager] SIGTERM on ephemeral orphan after spawn-lock-timeout failed',
          );
        }
      }
      await removeDir(tempProjectDir).catch(() => {});
      throw this.buildSpawnFailureError({
        pid: handle.pid,
        exit: childExit,
        lockDir,
        deadlineMs: waitedDeadlineMs,
        spawnLabel: 'ephemeral spawn',
        childExited,
      });
    }

    const port = lock.port;
    const apiOrigin = lockApiOrigin(lock);
    this.deps.log?.info(
      {
        event: 'desktop-ephemeral-server-spawned',
        pid: handle.pid,
        port,
        lockDir,
        file: opts.canonicalFilePath,
      },
      '[window-manager] ephemeral single-file server ready',
    );

    const window = this.deps.createWindow({
      additionalArguments: [
        `--ok-collab-url=${lockCollabUrl(lock)}`,
        `--ok-api-origin=${apiOrigin}`,
        // The renderer's project label / asset base is the file's real parent.
        `--ok-project-path=${opts.contentDir}`,
        `--ok-project-name=${projectName}`,
        `--ok-mode=editor`,
        // Single-file signal for the renderer's no-project chrome gate. The
        // desktop loads the shell from `file://` (not the server origin), so
        // `/api/config` is unreachable here — the flag rides the bridge config
        // (the same channel as collab-url / api-origin), mirroring `useCollabUrl`'s
        // Electron short-circuit. The browser fallback reads it from `/api/config`.
        `--ok-single-file=1`,
        // The doc to open on first paint. The renderer seeds it into
        // `window.location.hash` before React mounts (`seedInitialDocHash`), so
        // the editor lands on the file deterministically. This replaces a
        // post-load `ok:deep-link` IPC, which the renderer subscribes to lazily
        // (`ipcRenderer.on` only once `main.tsx` runs) with no preload buffer —
        // a `dom-ready` send that beat that registration dropped, leaving the
        // hash empty → the empty-state splash. The ephemeral window starts from
        // a fresh temp dir (no session/tab restore), so a drop had no safety net.
        `--ok-initial-doc=${opts.docName}`,
        `--ok-app-version=${this.deps.appVersion}`,
        ...instanceLabelArgs(),
      ],
      title: formatEditorTitle(projectName),
      // Focus-recency key = canonical file path, so this loose-file window
      // joins the restore ordering without writing `lastOpenedProject`.
      focusKey: canonicalKey,
    });
    // Asset root is the file's real parent (`opts.contentDir`), NOT the throwaway
    // temp projectDir — so `![[sibling]]` assets are allowlisted against the
    // directory they actually live in.
    this.attachSafetyNet(window.webContents, apiOrigin, opts.contentDir);

    const disposeShowGate = this.deps.showGate.register(window, { kind: 'editor' });

    const context: ProjectContext = {
      projectPath: opts.contentDir,
      canonicalKey,
      projectName,
      port,
      apiOrigin,
      window,
      utility: null,
      ownsServer: false,
      ephemeral: { projectDir: tempProjectDir, pid: handle.pid, lockDir },
    };
    // Exit-watch handle — shared by the `'closed'` handler (below) and the
    // liveness poll (further below). The spawner observes the child's `'exit'`
    // but exposes it only as a pull snapshot (`readExit`), not a push signal to
    // this class, so the poll is how the manager proactively notices a death;
    // once the window closes or the session is invalidated, the interval must be
    // cleared.
    let watchHandle: unknown;
    let watchCleared = false;
    const stopExitWatch = (): void => {
      if (watchCleared) return;
      watchCleared = true;
      if (watchHandle !== undefined) this.deps.clearInterval?.(watchHandle);
    };

    const releaseLoadingContext = this.publishLoadingContext(context);

    try {
      try {
        if (this.deps.rendererDevUrl) {
          await window.loadURL(this.deps.rendererDevUrl);
        } else {
          await window.loadFile(this.deps.rendererEntryPath);
        }
      } catch (err) {
        // Stop a window we are about to `destroy()` from resolving to a project
        // before the awaited teardown below; the outer bracket is the backstop.
        releaseLoadingContext();
        // Renderer load failed AFTER the server spawned + bound its lock. The
        // window never reaches the `'closed'` teardown below (it isn't in
        // `windowsByPath` yet), so reap here: drop the show gate, destroy the
        // never-shown window, and terminate the detached server + remove its temp
        // dir. Without this the server pid + `ok-ephemeral-*` temp dir orphan.
        disposeShowGate();
        window.destroy?.();
        await this.teardownEphemeralSession({
          projectDir: tempProjectDir,
          pid: handle.pid,
          lockDir,
        });
        throw err;
      }

      window.on('closed', () => {
        // Stop the liveness poll first — the session is going away under the normal
        // teardown path; a straggling poll must not fire a second teardown.
        stopExitWatch();
        disposeShowGate();
        // Drop this window's restart identity UNCONDITIONALLY — ahead of the
        // ownership guard. The identity is per-window, so it must clear whenever
        // THIS window closes, including the orphaned dead-window case where the
        // guard short-circuits (a re-open already took the slot).
        this.ephemeralWindowIdentity.delete(window);
        // Ownership guard — only tear down if THIS window still owns the slot. A
        // focus-dedup re-open or `stopAllOwnedServers` could have replaced/cleared
        // the entry; without the guard we'd terminate a sibling's server or double
        // free. (Double teardown is itself safe — ESRCH + force-rm — but the guard
        // keeps the common path single-pass.)
        if (this.windowsByPath.get(canonicalKey) !== context) return;
        this.windowsByPath.delete(canonicalKey);
        // Close the ephemeral keepalive before the server teardown — mirrors the
        // project-window close. No-op when none was opened (unwired harness).
        this.closeKeepalive(canonicalKey);
        // Fire-and-forget: the `'closed'` event handler is synchronous. Terminate
        // the server THEN remove the temp dir (sequential — see
        // `teardownEphemeralSession`).
        void this.teardownEphemeralSession(
          context.ephemeral as NonNullable<ProjectContext['ephemeral']>,
        );
      });

      this.windowsByPath.set(canonicalKey, context);
      // Hold the ephemeral server against its own idle-shutdown for as long as
      // this window is open. The single-file server inherits the 30-min idle
      // default but, unlike a project window, had no keepalive — so with no
      // editor WebSocket to reset the idle timer (the timer counts only /collab
      // connections) it could idle-shut-down underneath the open editor. Mirrors
      // the project-window keepalive: keyed by canonicalKey, the pre-set close
      // guards a re-open replacing the slot, and the `'closed'` handler above
      // tears it down.
      if (this.deps.createKeepalive) {
        const existingKeepalive = this.keepalives.get(canonicalKey);
        if (existingKeepalive) existingKeepalive.close();
        this.keepalives.set(canonicalKey, this.deps.createKeepalive({ lockDir }));
      }
      // Durable window→identity record for the restart affordance (survives a
      // re-open replacing the slot; cleared on real window close).
      this.ephemeralWindowIdentity.set(window, {
        canonicalFilePath: opts.canonicalFilePath,
        contentDir: opts.contentDir,
        docName: opts.docName,
      });
      // Converge to one window per file: a fresh spawn happens because the
      // file's prior server(s) died; retire any windows still open for those
      // dead sessions now that a live replacement exists.
      this.retireStaleWindowsForFile(canonicalKey, window);
    } finally {
      releaseLoadingContext();
    }

    // Exit-watch: proactively notice a detached server that dies while its window
    // is still open (kill / crash / idle-shutdown) and reap its throwaway temp
    // dir, so it does not linger for the window's whole open lifetime. Armed only
    // when `setInterval` is wired (production); unwired harnesses rely on the
    // probe-on-dedup backstop, which alone repairs the reported re-open symptom.
    //
    // It deliberately does NOT delete the `windowsByPath` entry (unlike the
    // utility-fork `on('exit')` path). The entry is what keeps a still-open
    // window in the session-restore set (`getOpenWindows`); dropping it would
    // silently exclude the file from next-launch restore. Dedup correctness does
    // not need the delete — the dedup gate live-probes liveness on the next open
    // — so leaving the entry costs nothing and preserves restore. The window is
    // left open; retiring it gracefully is the renderer affordance's job.
    //
    // The whole body is wrapped in try/catch: this is the one new call site not
    // guarded by async/await propagation, and main runs with no
    // `uncaughtException` handler by design — a throw here (a probe dep, an errno
    // path) would take down every window, not just this one.
    if (this.deps.setInterval) {
      watchHandle = this.deps.setInterval(() => {
        try {
          if (watchCleared) return;
          // Superseded: a focus-dedup re-open or teardown replaced/cleared the
          // slot. Whoever owns it now runs its own watch — stop quietly.
          if (this.windowsByPath.get(canonicalKey) !== context) {
            stopExitWatch();
            return;
          }
          if (this.isEphemeralServerAlive(context)) return;
          // The detached server died while its window stayed open. Reap its temp
          // dir and stop; the entry stays for the reasons above.
          stopExitWatch();
          const eph = context.ephemeral as NonNullable<ProjectContext['ephemeral']>;
          this.deps.log?.warn(
            {
              event: 'desktop-ephemeral-server-exited',
              pid: eph.pid,
              lockDir: eph.lockDir,
              file: opts.canonicalFilePath,
            },
            '[window-manager] ephemeral server exited while its window was open — reaping the dead session temp dir',
          );
          // No `recordServerExit` here (unlike the utility-fork `on('exit')`
          // path): that record lands in `<lockDir>/last-server-exit.json`, and an
          // ephemeral lockDir lives inside the throwaway temp projectDir that this
          // teardown removes — a persistent project lock is re-attached and read
          // by a later bug-report bundle, but a throwaway one never is.
          //
          // Close the keepalive too: the server it was holding up is gone, and it
          // re-reads the lockDir this teardown removes on every attempt, so
          // leaving it open reconnect-loops against a deleted path for the
          // window's remaining lifetime — the same failure shape as an unbounded
          // renderer reauth loop, just in the main process. windowsByPath keeps
          // its entry (for session-restore), so the guarded `'closed'` teardown
          // still runs on a real close; `closeKeepalive` is idempotent.
          this.closeKeepalive(canonicalKey);
          void this.teardownEphemeralSession(eph);
        } catch (err) {
          this.deps.log?.warn(
            {
              event: 'desktop-ephemeral-watch-probe-failed',
              err,
              file: opts.canonicalFilePath,
              pid: context.ephemeral?.pid,
              lockDir: context.ephemeral?.lockDir,
            },
            '[window-manager] ephemeral server-liveness probe threw — skipping this poll cycle',
          );
        }
      }, EPHEMERAL_SERVER_WATCH_POLL_MS);
    }

    return context;
  }

  /**
   * Tear down an ephemeral single-file session: terminate the detached server,
   * THEN remove its throwaway temp projectDir. The order is load-bearing — the
   * server's lock release is `destroy()`'s final step, and it may still be
   * flushing persistence to `<projectDir>/.ok/local` until the process is gone;
   * removing the dir under a live server is a race. Idempotent: a second call
   * (the `'closed'` handler and `stopAllOwnedServers` can both reach a session)
   * hits ESRCH on the already-dead pid and a no-op `force` rm on the gone dir.
   *
   * Guaranteed non-rejecting: every caller invokes it fire-and-forget (`void`),
   * so a rejection would surface as an unhandled rejection — and main runs with
   * no `unhandledRejection` handler by design, which would crash every window.
   * The top-level try/catch makes that guarantee structural rather than relying
   * on each callee (`terminateServerByPid`, `removeDir`) never throwing.
   */
  private async teardownEphemeralSession(session: {
    projectDir: string;
    pid: number;
    lockDir: string;
  }): Promise<void> {
    try {
      const term = await this.terminateServerByPid(session.lockDir, session.pid);
      if (!term.ok) {
        this.deps.log?.warn(
          {
            event: 'desktop-ephemeral-teardown',
            outcome: term.reason,
            pid: session.pid,
            projectDir: session.projectDir,
          },
          '[window-manager] ephemeral server termination did not confirm; removing temp dir anyway',
        );
      }
      await this.deps.removeDir?.(session.projectDir).catch((err: unknown) => {
        this.deps.log?.warn(
          {
            event: 'desktop-ephemeral-teardown',
            err,
            projectDir: session.projectDir,
          },
          '[window-manager] failed to remove ephemeral temp dir',
        );
      });
    } catch (err) {
      this.deps.log?.warn(
        {
          event: 'desktop-ephemeral-teardown-unexpected',
          err,
          pid: session.pid,
          projectDir: session.projectDir,
        },
        '[window-manager] unexpected error tearing down ephemeral session',
      );
    }
  }

  /** Close a specific project window (called by IPC `ok:project:close`). */
  closeProjectWindow(projectPath: string): boolean {
    const ctx = this.windowsByPath.get(this.canonicalizeKey(projectPath));
    if (!ctx) return false;
    if (!ctx.ownsServer || !ctx.utility) {
      // Attach mode — the server belongs to a sibling process. Closing our
      // window drops our WS connection; we leave the server running so the
      // sibling (and any other windows) keep working.
      return true;
    }
    // Guard against detached IPC port — see rationale in the window-close
    // handler above.
    try {
      ctx.utility.postMessage({ type: 'shutdown' });
    } catch (err) {
      this.deps.log?.warn(
        { err, projectPath },
        'utility shutdown IPC failed in closeProjectWindow (likely already exited)',
      );
    }
    return true;
  }

  /**
   * Build the error for a detached spawn that never produced a usable lock.
   *
   * Two distinct failures reach here and they need different framings. A child
   * that is still running simply missed the deadline — the deadline is the
   * story. A child that has already exited did not "take too long"; it died,
   * and reporting a 15-second timeout for a crash that happened in 200 ms sends
   * the reader looking for a slow start that never occurred. That
   * misdescription is the reported defect, so the framing is chosen from
   * observed liveness rather than fixed.
   *
   * Takes the child's state as already-observed values rather than probing for
   * it, because BOTH facts must be sampled at one instant: the moment the poll
   * gave up, before the orphan SIGTERM. Re-reading either one here would let
   * our own kill land in between and be reported as the child's failure — a
   * merely-slow child described as `killed by SIGTERM`.
   *
   * `childExited: undefined` means liveness was never probed (no
   * `isProcessAlive` wired), which is distinct from "probed and alive": the
   * message may only claim the process was running when that was observed.
   */
  private buildSpawnFailureError(opts: {
    pid: number;
    exit: { code: number | null; signal: string | null } | null;
    lockDir: string;
    deadlineMs: number;
    spawnLabel: string;
    childExited: boolean | undefined;
  }): Error {
    const { pid, exit, lockDir, deadlineMs, spawnLabel, childExited } = opts;
    // Bound the tail so a runaway log doesn't blow up the error envelope.
    // Best-effort: a missing log file just falls through with no `stderrTail`.
    const STDERR_TAIL_BYTES = 8192;
    let stderrTail: string | undefined;
    try {
      // Bound to THIS attempt first. The file appends across spawns, so a
      // child that died having written nothing would otherwise hand the
      // previous attempt's stack trace to this failure, labelled as its cause —
      // a false record of exactly the kind this log exists to prevent.
      // `.trim()` matching the sibling shim reader: without it, a child whose
      // only output is a newline defeats the emptiness contract above and
      // renders a stderr section containing whitespace.
      const attempt = sliceLastSpawnAttempt(
        readFileSync(join(lockDir, SPAWN_ERROR_LOG), 'utf-8'),
      ).trim();
      stderrTail =
        attempt.length > STDERR_TAIL_BYTES ? `…${attempt.slice(-STDERR_TAIL_BYTES)}` : attempt;
    } catch (readErr) {
      // An absent log is expected — the child can die before opening the fd.
      // Anything else (permissions, a bad path) would otherwise vanish here and
      // leave the failure report silently thinner than it should be, on the one
      // path whose entire job is explaining a failure.
      const code = (readErr as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        this.deps.log?.warn(
          { event: 'desktop-spawn-error-log-read-failed', err: readErr, code, lockDir },
          '[window-manager] could not read the spawn error log',
        );
      }
    }

    const exited = exit !== null || childExited === true;

    let messageBase: string;
    if (exited) {
      const reason =
        exit === null
          ? ''
          : exit.signal !== null
            ? `, killed by ${exit.signal}`
            : exit.code !== null
              ? `, exit code ${exit.code}`
              : '';
      messageBase = `OpenKnowledge server exited before binding a port (pid=${pid}${reason}).`;
    } else {
      // A crash and a hung start otherwise render as the same bare deadline,
      // leaving no way to tell which happened. Saying the process was still
      // running names this as the slow/stuck case — but only when liveness was
      // actually observed, never as an assumption.
      const liveness = childExited === false ? ', still running' : '';
      messageBase = `OpenKnowledge server did not bind a port within ${deadlineMs}ms after ${spawnLabel} (pid=${pid}${liveness}).`;
    }

    // Whether the child's output explains the failure depends entirely on
    // whether it DIED. A child that exited is very likely explaining itself on
    // the way out, so its stderr reads as the cause and is labelled as such. A
    // child that is still running has explained nothing — whatever is in the
    // log is just what the server happened to print during a normal boot
    // (config advisories, deprecation notices), and juxtaposing it with a
    // failure header invites the reader to fix a warning that was never the
    // problem. Say so rather than filtering: a filter would also swallow the
    // one advisory that did matter.
    const stderrHeading = exited
      ? '--- stderr ---'
      : '--- server output (printed during startup; probably not the cause) ---';
    return Object.assign(
      new Error(stderrTail ? `${messageBase}\n${stderrHeading}\n${stderrTail}` : messageBase),
      {
        name: 'SpawnLockTimeoutError' as const,
        // Discriminant held stable across both framings — `index.ts` branches
        // on it, and the distinction between the two lives in the exit fields.
        kind: 'spawn-lock-timeout' as const,
        pid,
        ...(exit !== null && { exitCode: exit.code, exitSignal: exit.signal }),
        ...(stderrTail !== undefined && { stderrTail }),
      },
    );
  }

  /**
   * Poll `<lockDir>/server.lock` until a valid lock appears with `port > 0`
   * and a known `kind`. Used by the detached-spawn path to wait for the
   * freshly-spawned CLI to bind a port and write its lock atomically (the lock
   * writer in `bootServer` only flips port from `0` to the bound port after
   * `httpServer.listen` resolves, so seeing `port > 0` is the readiness
   * signal).
   *
   * The wait is TWO-TIER. `deadlineMs` bounds only a spawn showing no sign of
   * life; when it lands with someone still visibly working on this lock — our
   * `child`, or the live holder of a non-draining lock in the collision case —
   * the wait graduates ONCE to `progressDeadlineMs` (default
   * `deadlineMs * SPAWN_WAIT_EXTENSION_FACTOR`) rather than giving up. The
   * pre-`listen` boot phase scales with project state and emits no events, so
   * liveness is the only progress signal available; the cap is what keeps a
   * genuinely wedged process from waiting forever.
   *
   * The wait still ends early once the spawn is observed to have exited with
   * nobody else starting (a dead child will never publish a lock, so the rest
   * of the deadline is dead time).
   *
   * Always resolves to an object. `lock` is the parsed metadata on success and
   * `null` on timeout or child death; `waitedDeadlineMs` is the deadline
   * actually served, which the caller reports rather than the tier it
   * graduated from. When `readServerLock` is not wired in `deps` (back-compat
   * with tests that don't exercise the detached path), resolves immediately
   * with a `null` lock — the caller propagates that as a spawn-failure error.
   *
   * Polling cadence: 50 ms. Uses `deps.setTimeout` so test injections that
   * fire the timer synchronously make the loop deterministic.
   */
  private async pollServerLock(
    lockDir: string,
    deadlineMs: number,
    child?: { pid: number },
    progressDeadlineMs?: number,
  ): Promise<{ lock: ServerLockMetadataLike | null; waitedDeadlineMs: number }> {
    const POLL_INTERVAL_MS = 50;
    const reader = this.deps.readServerLock;
    if (!reader) return { lock: null, waitedDeadlineMs: deadlineMs };
    const isAlive = this.deps.isProcessAlive;
    const started = Date.now();
    // A cap below the startup deadline would shorten the wait rather than
    // extend it, inverting the whole point of the second tier.
    const hardCapMs = Math.max(
      deadlineMs,
      progressDeadlineMs ?? deadlineMs * SPAWN_WAIT_EXTENSION_FACTOR,
    );
    let effectiveDeadlineMs = deadlineMs;
    let deadline = started + deadlineMs;
    let extended = false;
    // Deliberately not `while (Date.now() < deadline)`: the graduation check
    // has to run ON the deadline, and a loop that exits at the top can have
    // its final poll interval straddle it — the child would then be killed
    // without ever being asked whether it was still alive.
    for (;;) {
      const lock = reader(lockDir);
      // A draining lock is the PREDECESSOR still exiting, not the fresh
      // spawn's readiness signal — keep polling until the successor's
      // (non-draining) lock appears.
      if (lock !== null && lock.draining !== true && lock.port > 0 && lock.kind !== undefined) {
        return { lock, waitedDeadlineMs: effectiveDeadlineMs };
      }
      // Liveness, not wall-clock, ends the wait once the child is gone: a dead
      // child will never publish a lock, so the rest of the deadline is dead
      // time, and spending it reframes a fast crash as a slow start.
      //
      // Checked AFTER the lock read — a child that bound and then exited still
      // leaves a usable lock, and that read must win.
      //
      // The exception is load-bearing: the lock is keyed by PROJECT, not by
      // process. When a concurrent starter wins the acquire, our child exits
      // BY DESIGN (a lock collision) while the winner is still on its way to
      // binding — the documented `port=0`-but-not-yet-bound window. Bailing on
      // our child's death would then report a failure that another process is
      // about to resolve. A non-draining lock held by a different, live pid is
      // exactly that signal, so keep waiting for the winner to publish a port.
      if (child !== undefined && isAlive !== undefined && !isAlive(child.pid)) {
        const winnerStillStarting =
          lock !== null && lock.draining !== true && lock.pid !== child.pid && isAlive(lock.pid);
        if (!winnerStillStarting) return { lock: null, waitedDeadlineMs: effectiveDeadlineMs };
      }
      if (Date.now() >= deadline) {
        // Slow is not hung. A spawn still running when the startup deadline
        // lands has not failed at anything — it is mid-boot — so giving up
        // there turns "this project takes a while to open" into "this project
        // cannot be opened", and every retry reproduces it. Graduate to the
        // hard cap instead, once, and record the decision: an operator reading
        // the log needs to see that the wait was extended and on what evidence.
        //
        // "Still starting" is asked of whoever is actually booting this
        // project, not only of our own child. In the lock-collision case above
        // our child is dead BY DESIGN and the live holder of the non-draining
        // lock is the one mid-boot — binding it to our child's liveness would
        // cut the winner off at the startup deadline and reintroduce exactly
        // the failure this tier exists to prevent, one branch over.
        const childStarting = child !== undefined && isAlive?.(child.pid) === true;
        const holderStarting =
          lock !== null && lock.draining !== true && isAlive?.(lock.pid) === true;
        const stillStarting =
          !extended && hardCapMs > deadlineMs && (childStarting || holderStarting);
        if (!stillStarting) return { lock: null, waitedDeadlineMs: effectiveDeadlineMs };
        extended = true;
        effectiveDeadlineMs = hardCapMs;
        deadline = started + hardCapMs;
        this.deps.log?.info(
          {
            event: 'desktop-spawn-wait-extended',
            pid: child?.pid,
            lockDir,
            startupDeadlineMs: deadlineMs,
            hardCapMs,
            // Which of the two signals earned the extension: our own child, or
            // the live holder of the lock our child lost the race for.
            startingParty: childStarting ? 'child' : 'lock-holder',
            // The server publishes its lock with a `port: 0` sentinel early in
            // boot, so its presence separates "alive and initializing" from
            // "alive but has not started booting" in the log.
            lockPublished: lock !== null,
          },
          '[window-manager] server still starting at the spawn deadline — extending the wait',
        );
      }
      await new Promise<void>((resolveSleep) => {
        this.deps.setTimeout(() => {
          resolveSleep();
        }, POLL_INTERVAL_MS);
      });
    }
  }

  /**
   * Synchronous metadata gates for `<lockDir>/server.lock`.
   *
   * Returns the lock when all of the following hold:
   *   - lock file exists and parses as valid JSON
   *   - `hostname` matches this host (foreign locks fall through to spawn
   *     mode, which surfaces the collision via `ServerLockCollisionError`
   *     from `acquireServerLock`)
   *   - `isProcessAlive(pid)` is true (stale locks fall through — `runClean`
   *     will prune them before we spawn)
   *   - `port > 0` (port 0 means the holder is still starting — racing it
   *     risks connecting before the listener is bound, so fall through)
   *   - `kind` is present (absent → legacy lock, refused as the conservative
   *     case). BOTH `kind === 'interactive'` AND `kind === 'mcp-spawned'`
   *     attach: the kind is a provenance label only — every `bootServer`
   *     exposes the same HTTP + WS capabilities regardless. Attaching to
   *     an MCP-spawned holder keeps the agent's session alive instead of
   *     terminating it.
   *   - `capabilities` includes `"ws"` when the field is present.
   *
   * The async WS-upgrade probe is deliberately a separate step
   * (`probeAttachableLock`) so this function stays synchronous — the
   * synchronous fall-through must not inject a microtask that reorders
   * subsequent fork-utility calls in the caller.
   *
   * Refusals emit a structured warn so operators can grep for
   * `desktop-attach-refused` in the wild.
   */
  private tryAttachExistingServer(lockDir: string): ServerLockMetadataLike | null {
    const read = this.deps.readServerLock;
    const alive = this.deps.isProcessAlive;
    const getHost = this.deps.hostname;
    if (!read || !alive || !getHost) return null;
    const lock = read(lockDir);
    if (!lock) return null;
    const refuse = (reason: string): null => {
      this.deps.log?.warn(
        { event: 'desktop-attach-refused', reason, lockDir, lockPid: lock.pid },
        '[window-manager] refusing attach',
      );
      return null;
    };
    if (!isValidLockPidLocal(lock.pid)) return refuse('invalid-lock-pid');
    // Machine identity: locks carrying `machineId` were already machine-
    // checked inside `readServerLock` (machineId-first, hostname only as the
    // legacy fallback) — re-checking the hostname here would wrongly refuse
    // a same-machine lock written before a hostname drift/rename. Only
    // legacy locks (no machineId) still need the hostname comparison.
    if (lock.machineId === undefined && lock.hostname !== getHost()) {
      return refuse('foreign-hostname');
    }
    if (!alive(lock.pid)) return refuse('lock-pid-dead');
    // Draining = teardown began; the port closes before the process exits.
    // Attaching would bind the window to a dying backend — fall through to
    // spawn mode, whose `ok start` child waits out the drain.
    if (lock.draining === true) return refuse('lock-draining');
    // A STRICTER question than the recovery rule's: not whether anything could
    // be there, but whether we could HOLD it. A numeric string passes the first
    // and fails this one. Deliberately decided on `port` alone even when the
    // `url` is perfectly good, because the keepalive reads the port and nothing
    // else; `port <= 0` would not do, since it admits `Infinity` to be formatted
    // into a probe URL nothing can answer.
    if (!lockIsAttachable(lock)) return refuse('lock-not-attachable');
    if (lock.kind === undefined) return refuse('legacy-lock-no-kind');
    if (lock.capabilities !== undefined && !lock.capabilities.includes('ws')) {
      return refuse('capabilities-missing-ws');
    }
    return lock;
  }

  /**
   * `probeAttachableLock` with a bounded grace, for the callers whose verdict on
   * a failed probe is one-way: the detached-spawn gate fails the open, and the
   * recovery path deletes the holder's claim.
   *
   * The attach path can afford a single shot: a refusal there falls through to
   * spawning our own server, so a false negative costs a redundant spawn. The
   * detached-spawn path has already spawned, so its refusal fails the open —
   * and the lock it is judging belongs to a concurrent starter caught at its
   * youngest. The port-0 sentinel means `port > 0` implies `listen()` has
   * bound, but binding is not the same as serving `/collab`: a hung or
   * mid-wiring upgrade path is the exact symptom `probeAttachableLock` exists
   * for. One 500 ms shot at that moment would refuse healthy winners.
   *
   * Retries are cheap here because the failure they guard against is expensive
   * and one-way, and because a genuinely dead port fails fast on connection
   * refused rather than burning the timeout.
   */
  private async probeForeignLockWithGrace(
    lock: { pid: number; port?: unknown; url?: unknown },
    phase: ProbePhase = 'spawn-foreign-lock',
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= FOREIGN_LOCK_PROBE_ATTEMPTS; attempt++) {
      if (await this.probeAttachableLock(lock, phase)) return true;
      if (attempt < FOREIGN_LOCK_PROBE_ATTEMPTS) {
        await new Promise<void>((resolveSleep) => {
          this.deps.setTimeout(() => resolveSleep(), FOREIGN_LOCK_PROBE_RETRY_MS);
        });
      }
    }
    return false;
  }

  /**
   * Final defensive gate against a server that lies about WS capability or
   * has a hung upgrade path (the live symptom that motivated all of this:
   * HTTP up, `/collab` hangs, every doc 30 s timeouts). Skipped when
   * `probeWsUpgrade` is not injected — back-compat path for the existing
   * test suite that did not exercise the probe.
   *
   * Returns `true` when attaching is safe; `false` otherwise. Errors from
   * the probe (thrown rejections) are treated as failures — defensive
   * stance, since we cannot prove the server is healthy.
   */
  private async probeAttachableLock(
    // Only the fields the probe reads: the address to dial and the pid to name
    // in the refusal. Narrow so callers holding a partially-parsed lock can ask
    // without fabricating the rest.
    lock: { pid: number; port?: unknown; url?: unknown },
    phase: ProbePhase = 'attach',
  ): Promise<boolean> {
    const probe = this.deps.probeWsUpgrade;
    if (!probe) return true;
    const url = `${lockCollabUrl(lock)}/__attach_probe__`;
    let upgradeOk = false;
    try {
      upgradeOk = await probe(url, 500);
    } catch {
      upgradeOk = false;
    }
    if (!upgradeOk) {
      this.deps.log?.warn(
        {
          event: 'desktop-attach-refused',
          reason: 'ws-upgrade-failed',
          lockPid: lock.pid,
          // Which decision this probe was informing. The event name predates
          // the second caller, and a bundle that cannot tell an attach-gate
          // refusal from a spawn-path one reads as the same verdict twice on
          // one port — the exact confusion that made this class hard to
          // diagnose from logs in the first place.
          phase,
        },
        '[window-manager] refusing attach',
      );
    }
    return upgradeOk;
  }

  /**
   * Finalize a project window in attach mode. Symmetric with the spawn path
   * from the renderer's perspective — `--ok-collab-url` and `--ok-api-origin`
   * are populated identically, so the preload + React bundle see no
   * difference between attach-mode and spawn-mode windows.
   *
   * Differences from spawn mode:
   *   - no `utilityProcess.fork`, no `init`/`ready` handshake
   *   - no `runClean` (the lock is not stale — it references a live process)
   *   - no post-exit liveness probe (we don't own the server)
   *   - window `close` removes the window from the map but sends no shutdown
   *     IPC (the sibling server survives)
   */
  private async attachToExistingServer(args: {
    projectPath: string;
    canonicalKey: string;
    projectName: string;
    lock: ServerLockMetadataLike;
    pendingDeepLinkTarget?: {
      kind: 'doc' | 'folder';
      path: string;
      repositoryPath?: string;
      contentRootDepth?: number;
    };
    pendingBranch?: string | null;
    pendingMultiCandidate?: boolean;
    pendingTargetMissing?: boolean;
    pendingShareBranchSwitch?: ShareDeepLinkBranchSwitchPayload;
    pendingServerRestartedToast?: boolean;
    /**
     * First-run create-new signal, forwarded from `createProjectWindow`'s opts.
     * Attach mode is the PRODUCTION path (detached-spawn + direct-attach both
     * land here), so the onboarding card's `--ok-fresh-create=1` MUST be
     * injected here too — the utility-fork branch is dev/test only.
     */
    freshlyCreated?: boolean;
  }): Promise<ProjectContext> {
    const {
      projectPath,
      canonicalKey,
      projectName,
      lock,
      pendingDeepLinkTarget,
      pendingBranch,
      pendingMultiCandidate,
      pendingTargetMissing,
      pendingShareBranchSwitch,
      pendingServerRestartedToast,
      freshlyCreated,
    } = args;
    const port = lock.port;
    const apiOrigin = lockApiOrigin(lock);

    this.deps.log?.info(
      {
        projectPath,
        holderPid: lock.pid,
        port,
        startedAt: lock.startedAt,
        apiOrigin,
        capabilities: lock.capabilities,
      },
      'attaching to existing OpenKnowledge server',
    );

    // Startup waterfall: the lock is readable on entry — record its `startedAt`.
    // Idempotent on the waterfall side (first write wins) so the detached-spawn
    // path's earlier mark is preserved when this is reached via spawn.
    this.deps.startup?.markServerLockReady?.({ startedAt: lock.startedAt, apiOrigin });

    const window = this.deps.createWindow({
      additionalArguments: [
        `--ok-collab-url=${lockCollabUrl(lock)}`,
        `--ok-api-origin=${apiOrigin}`,
        `--ok-project-path=${projectPath}`,
        `--ok-project-name=${projectName}`,
        `--ok-mode=editor`,
        `--ok-app-version=${this.deps.appVersion}`,
        ...instanceLabelArgs(),
        ...(this.deps.startup?.traceparent !== undefined
          ? [`--ok-startup-traceparent=${this.deps.startup.traceparent}`]
          : []),
        // Mirror the utility-fork branch's injection: attach mode is the
        // production path, so a first-run create-new (blank or starter-pack
        // seed) must surface `freshlyCreated` here too or the onboarding card
        // never activates in packaged builds.
        ...(freshlyCreated ? ['--ok-fresh-create=1'] : []),
      ],
      title: formatEditorTitle(projectName),
      projectPath,
    });
    this.deps.startup?.markWindowCreated?.();
    this.attachSafetyNet(window.webContents, apiOrigin, projectPath);

    // Deep-link gate — same pattern as the spawn path. Register the
    // `dom-ready` listener BEFORE `await loadURL` so the one-shot event
    // lands after the renderer subscriber mounts but not after
    // `did-finish-load` (which would miss dom-ready entirely).
    if (pendingDeepLinkTarget) {
      const doc = pendingDeepLinkTarget.path;
      const kind = pendingDeepLinkTarget.kind;
      const branch = pendingBranch ?? null;
      const multiCandidate = pendingMultiCandidate === true;
      registerPendingDelivery(window.webContents, 'ok:deep-link', {
        doc,
        kind,
        branch,
        multiCandidate,
        ...(pendingDeepLinkTarget.repositoryPath === undefined
          ? {}
          : { repositoryPath: pendingDeepLinkTarget.repositoryPath }),
        ...(pendingDeepLinkTarget.contentRootDepth === undefined
          ? {}
          : { contentRootDepth: pendingDeepLinkTarget.contentRootDepth }),
        ...(pendingTargetMissing === true ? { targetMissing: true } : {}),
      });
    }

    if (pendingShareBranchSwitch) {
      const branchSwitch = pendingShareBranchSwitch;
      registerPendingDelivery(window.webContents, 'ok:share:received', {
        kind: 'project-branch-switch' as const,
        share: branchSwitch.share,
        projectPath: branchSwitch.projectPath,
        currentBranch: branchSwitch.currentBranch,
      });
    }

    // Version-drift detection. We are in attach mode (`ownsServer === false`),
    // so the server may be a different build than this app — classify the
    // lock's version against our own and, on a real older/newer mismatch,
    // notify the renderer once the subscriber has mounted. `same` and
    // `indeterminate` (legacy lock, unknown sentinel) fire nothing. Skipped
    // when the desktop's own version wasn't wired (test harnesses). Registered
    // before `await loadURL` for the same dom-ready timing reason as the
    // deep-link dispatch above.
    const selfProtocol = this.deps.selfProtocolVersion;
    const selfRuntime = this.deps.selfRuntimeVersion;
    const serverRuntime = lock.runtimeVersion;
    if (selfProtocol !== undefined && selfRuntime !== undefined) {
      const drift = classifyServerVersion(
        { protocolVersion: lock.protocolVersion, runtimeVersion: serverRuntime },
        { protocolVersion: selfProtocol, runtimeVersion: selfRuntime },
      );
      // `older`/`newer` is only returned when both lock fields are present, so
      // `serverRuntime` is non-null here — narrow it structurally rather than
      // defaulting (a default would silently misrepresent the server version).
      if (
        (drift.relation === 'older' || drift.relation === 'newer') &&
        serverRuntime !== undefined
      ) {
        const payload = {
          relation: drift.relation,
          dimension: drift.dimension ?? 'runtime',
          serverRuntime,
          appRuntime: selfRuntime,
        } as const;
        registerPendingDelivery(window.webContents, 'ok:server-version-drift', payload);
      }
    }

    // Server-restart confirmation. When this window is the freshly-recreated
    // replacement after a successful restart, confirm the new (matching)
    // server on the renderer. `did-finish-load` (not `dom-ready`) mirrors the
    // onboarding-toast delivery so the sonner subscriber is mounted.
    if (pendingServerRestartedToast && selfRuntime !== undefined) {
      registerPendingDelivery(
        window.webContents,
        'ok:server-restarted',
        { appRuntime: selfRuntime },
        { event: 'did-finish-load' },
      );
    }

    // Defer OS-level window display until both first-paint AND chrome-theme
    // signals arrive — same dual-signal gate as the spawn path (and as
    // `createNavigatorWindow`). Without this, `DEFAULT_WIN_OPTS.show: false`
    // would leave the attach-mode window permanently hidden once `loadURL`
    // resolves. Registered before `await loadURL` for the same reason as the
    // `dom-ready` listener above — events can fire before the await resolves
    // on a fast load.
    const disposeShowGate = this.deps.showGate.register(window, { kind: 'editor' });

    const context: ProjectContext = {
      projectPath,
      canonicalKey,
      projectName,
      port,
      apiOrigin,
      window,
      utility: null,
      ownsServer: false,
    };
    const releaseLoadingContext = this.publishLoadingContext(context);
    try {
      if (this.deps.rendererDevUrl) {
        await window.loadURL(this.deps.rendererDevUrl);
      } else {
        await window.loadFile(this.deps.rendererEntryPath);
      }
      this.deps.startup?.markLoadUrlResolved?.();

      // Open the keepalive WS as soon as the project window mounts. The WS
      // counts toward the server's idle-shutdown WS-client tally so a brief
      // MCP disconnect (the agent restarts, the IDE reloads its MCP shim,
      // etc.) does not trigger idle-shutdown while the user has a project
      // window open. Presence-invisibility is enforced by the wired
      // `createKeepalive` (which omits `displayName`/`clientName`/
      // `colorSeed`); the dep contract documents this constraint.
      if (this.deps.createKeepalive) {
        const existingKeepalive = this.keepalives.get(canonicalKey);
        // Defensive idempotence — a second window for the same project (e.g.
        // a deep-link re-open while the previous one is mid-teardown) would
        // race the close handler. Drop the old handle before opening a new
        // one so we never leak.
        if (existingKeepalive) existingKeepalive.close();
        const lockDir = getLocalDir(projectPath);
        const handle = this.deps.createKeepalive({ lockDir });
        this.keepalives.set(canonicalKey, handle);
      }

      window.on('closed', () => {
        // Drop any stale show-gate state — a window destroyed before either
        // signal arrives must not hold a slot in the registry's Map.
        disposeShowGate();
        // Only release the project's slot if THIS window still owns it. A
        // server-restart recreate detaches the originating window from the map
        // and replaces it under the same `canonicalKey` before closing the old
        // one — without this guard the old window's `'closed'` would delete the
        // new window's entry (and its keepalive).
        if (this.windowsByPath.get(canonicalKey) !== context) return;
        // Close the project's keepalive WS so the server's idle-shutdown
        // counter can fall back to whatever MCP clients (if any) are still
        // connected. No-op when no keepalive was opened (back-compat tests).
        const keepalive = this.keepalives.get(canonicalKey);
        if (keepalive) {
          keepalive.close();
          this.keepalives.delete(canonicalKey);
        }
        // Drop from our map so a subsequent open either re-attaches (if the
        // sibling is still live) or spawns (if it has since exited). Critically,
        // NO shutdown IPC — the server is not ours to stop.
        this.windowsByPath.delete(canonicalKey);
      });

      this.windowsByPath.set(canonicalKey, context);
    } finally {
      releaseLoadingContext();
    }
    return context;
  }
}
