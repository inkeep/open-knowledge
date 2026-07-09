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
  DEFAULT_SIGTERM_GRACE_MS,
  DEFAULT_SIGTERM_POLL_MS,
  SPAWN_ERROR_LOG,
} from '@inkeep/open-knowledge-core';
import type { KeepaliveHandle } from '@inkeep/open-knowledge-core/keepalive';
import { getLocalDir } from '@inkeep/open-knowledge-server';
import type { OkServerRestartOutcome } from '../shared/bridge-contract.ts';
import { registerPendingDelivery } from '../shared/ipc-send.ts';
import type { ShowGateRegistry } from './show-gate.ts';
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
     * `will-navigate` + `setWindowOpenHandler` used by the asset-click
     * safety net. Narrow structural signature — tests that don't exercise
     * the safety net can leave these as no-ops. Matches Electron's
     * `WebContents` at runtime.
     */
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void;
    on(
      event: 'will-navigate',
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
  pendingDeepLinkTarget?: { kind: 'doc' | 'folder'; path: string };
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
   * Upper bound (ms) on waiting for the detached server to publish a valid
   * `server.lock` after spawn. Default 15s — generous margin for the
   * `bootServer` cold-start path (shadow-repo init, file-watcher walk,
   * listen + lock write) while keeping a silently-hung spawn detectable
   * within a debuggable window. Tests pass small values.
   */
  spawnLockPollDeadlineMs?: number;
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
   * build. Act-then-inform: the freshly-spawned window fires `ok:server-
   * reclaimed` so the renderer can surface the dropped-MCP side effect.
   *
   * Wired from `!app.isPackaged` in `index.ts`; never set in packaged builds
   * (a packaged user attaching to a live server is the intended shared-server
   * behavior, not drift to reclaim). Omitted/false → the attach path behaves
   * exactly as before.
   */
  reclaimForeignServerInDev?: boolean;
  /** Schedule a one-shot timer (test injection for the post-exit liveness probe). */
  setTimeout(cb: () => void, ms: number): unknown;
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
   * after `init`. Default 15s — enough margin for `bootServer` to run shadow-
   * repo init + initial file-watcher walk on a large project, narrow enough
   * that a silently-hung utility surfaces within a debuggable window. Test
   * injections typically pass a much smaller value.
   */
  utilityInitTimeoutMs?: number;
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
          err: (err as Error).message,
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
        { err: (err as Error).message, projectPath: ctx.projectPath },
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
  focusWindowForProject(projectPath: string): BrowserWindowLike | null {
    const ctx = this.windowsByPath.get(this.canonicalizeKey(projectPath));
    if (!ctx) return null;
    this.bringToFront(ctx.window);
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
   */
  private bringToFront(win: BrowserWindowLike): void {
    if (win.isMinimized?.()) win.restore?.();
    win.show?.();
    const alreadyFrontmost = win.isFocused?.() === true;
    win.moveTop?.();
    win.focus();
    if (!alreadyFrontmost) this.deps.activateApp?.();
  }

  /**
   * Resolve the ProjectContext that owns a given BrowserWindow. Used by IPC
   * handlers that receive `event.sender.webContents` → BrowserWindow and need
   * to look up the window's project. Iterates `windowsByPath` (authoritative
   * map) instead of going through `appState.recentProjects`, which avoids a
   * stale-state race between `createProjectWindow` resolving and
   * `addRecentProject` persisting.
   */
  getContextForBrowserWindow(win: BrowserWindowLike): ProjectContext | undefined {
    for (const ctx of this.windowsByPath.values()) {
      if (ctx.window === win) return ctx;
    }
    return undefined;
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
    // `quitAndInstall`, but ShipIt's pre-swap `pgrep` check (the
    // `SQRLInstallerErrorDomain Code=-9 "App Still Running"` failure)
    // wants the tree clean BEFORE it polls.
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
        this.deps.log?.warn(
          { err: (err as Error).message, pid, projectPath },
          'SIGTERM failed during stopAllOwnedServers',
        );
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
            err: (err as Error).message,
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
    try {
      pid = (JSON.parse(readFileSync(join(lockDir, 'server.lock'), 'utf-8')) as { pid?: unknown })
        ?.pid;
    } catch {
      // No lock / unreadable — nothing to stop; the retry will proceed.
      return { ok: true };
    }
    if (!isValidLockPidLocal(pid) || pid === process.pid) {
      return { ok: true };
    }
    const term = await this.terminateServerByPid(lockDir, pid);
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
    // Detach the originating window from the map (so the recreate spawns a new
    // window instead of focusing the old) but keep it open until the new one
    // exists — see the failure branch below.
    const originating = this.windowsByPath.get(canonicalKey);
    if (originating) this.windowsByPath.delete(canonicalKey);
    try {
      await this.createProjectWindow({
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
    if (originating) await this.closeAndAwait(originating.window);
    return { ok: true };
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

  async createProjectWindow(opts: CreateProjectWindowOpts): Promise<ProjectContext> {
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
    // Dev-only reclaim: when the attachable server is foreign (not one this
    // session spawned), terminate it and fall through to a fresh own-build
    // spawn instead of attaching. `spawnedDetachedPids` is empty under the dev
    // utility-fork path, so the pid guard reads as "always foreign" there — but
    // it stays load-bearing if a future build wires detached spawn in dev (then
    // a same-session reopen would re-attach to our OWN server, which we must
    // NOT kill). On termination failure we fall back to attaching, never
    // leaving the project window-less.
    let pendingServerReclaimedToast = false;
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
      pendingServerReclaimedToast = true;
    }

    if (this.deps.runClean) {
      try {
        await this.deps.runClean({ lockDir });
      } catch (err) {
        this.deps.log?.warn(
          { err: (err as Error).message, lockDir },
          'runClean failed; proceeding to spawn server',
        );
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
      const POLL_DEADLINE_MS = this.deps.spawnLockPollDeadlineMs ?? 15_000;
      const lock = await this.pollServerLock(lockDir, POLL_DEADLINE_MS);
      if (lock === null) {
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
                err: (signalErr as Error).message,
                code,
                pid: handle.pid,
                projectPath,
              },
              '[window-manager] SIGTERM on orphan after spawn-lock-timeout failed',
            );
          }
        }
        this.spawnedDetachedPids.delete(canonicalKey);
        // Read the spawned child's stderr capture so the surfaced error
        // points at the actual failure (port-bind error, missing native
        // dep, bootServer init throw) instead of leaving the user with a
        // generic 15-second timeout. Bound the tail so a runaway log
        // doesn't blow up the error envelope. Best-effort: missing log
        // file just falls through with no `stderrTail`.
        const STDERR_TAIL_BYTES = 8192;
        let stderrTail: string | undefined;
        try {
          const raw = readFileSync(join(lockDir, SPAWN_ERROR_LOG), 'utf-8');
          stderrTail = raw.length > STDERR_TAIL_BYTES ? `…${raw.slice(-STDERR_TAIL_BYTES)}` : raw;
        } catch {
          // Best-effort: the spawn might have died before opening the fd.
        }
        const messageBase = `OpenKnowledge server did not bind a port within ${POLL_DEADLINE_MS}ms after spawn (pid=${handle.pid}).`;
        const err = Object.assign(
          new Error(stderrTail ? `${messageBase}\n--- stderr ---\n${stderrTail}` : messageBase),
          {
            name: 'SpawnLockTimeoutError' as const,
            kind: 'spawn-lock-timeout' as const,
            pid: handle.pid,
            ...(stderrTail !== undefined && { stderrTail }),
          },
        );
        throw err;
      }
      this.deps.log?.info(
        { event: 'desktop-server-spawned-detached', pid: handle.pid, port: lock.port, lockDir },
        '[window-manager] detached server ready',
      );
      // Startup waterfall: the detached server's lock is now readable — carry
      // its `startedAt` (clock-skew term) + `apiOrigin` (server-info fetch).
      this.deps.startup?.markServerLockReady?.({
        startedAt: lock.startedAt,
        apiOrigin: `http://localhost:${lock.port}`,
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
        host: 'localhost',
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
    });
    this.deps.startup?.markWindowCreated?.();

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

    // Dev-reclaim notice. This is the SOLE delivery site: reclaim is gated to
    // `!app.isPackaged`, where the spawn always takes this utility-fork branch
    // (detached spawn is wired only in packaged builds), so the flag can only
    // ever be truthy here. Fire on `did-finish-load` so the sonner subscriber
    // is mounted, same as the restarted/onboarding toasts. `appVersion` is
    // always present, so the inform fires unconditionally.
    if (pendingServerReclaimedToast) {
      registerPendingDelivery(
        window.webContents,
        'ok:server-reclaimed',
        { appRuntime: this.deps.appVersion },
        { event: 'did-finish-load' },
      );
    }

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
          { err: (err as Error).message, projectPath },
          'utility shutdown IPC failed on window close (likely already exited)',
        );
      }
    });

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
    this.windowsByPath.set(canonicalKey, context);
    return context;
  }

  /**
   * Open (or focus) an ephemeral single-file editing session for a no-project
   * file (`ok <file>`). Distinct from `createProjectWindow` in three ways that
   * make a dedicated method cleaner than threading an `ephemeral` flag through
   * that 450-line path:
   *   - **Dedup on the canonical FILE path**: a second `ok <samefile>`
   *     focuses the existing window rather than spawning a second server on the
   *     same inode (which would clobber the file). The dedup check runs BEFORE
   *     any temp-dir creation so a focus never leaks a throwaway dir.
   *   - **Slim single-file boot** in a throwaway temp `projectDir` (git + MCP
   *     off, content scoped to the one doc): no `.ok/` lands in the user's dir.
   *   - **Deterministic teardown** on window-close: a detached server would
   *     otherwise survive the close. The `'closed'`
   *     handler terminates the pid then removes the temp dir, sequentially.
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
      if (existing.window.isDestroyed?.() !== true) {
        this.bringToFront(existing.window);
        return existing;
      }
      this.deps.log?.warn(
        { canonicalKey },
        '[window-manager] stale destroyed ephemeral entry — clearing and re-creating',
      );
      this.windowsByPath.delete(canonicalKey);
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
    let handle: { pid: number };
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

    const POLL_DEADLINE_MS = this.deps.spawnLockPollDeadlineMs ?? 15_000;
    const lock = await this.pollServerLock(lockDir, POLL_DEADLINE_MS);
    if (lock === null) {
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
              err: (signalErr as Error).message,
              code,
              pid: handle.pid,
            },
            '[window-manager] SIGTERM on ephemeral orphan after spawn-lock-timeout failed',
          );
        }
      }
      await removeDir(tempProjectDir).catch(() => {});
      const STDERR_TAIL_BYTES = 8192;
      let stderrTail: string | undefined;
      try {
        const raw = readFileSync(join(lockDir, SPAWN_ERROR_LOG), 'utf-8');
        stderrTail = raw.length > STDERR_TAIL_BYTES ? `…${raw.slice(-STDERR_TAIL_BYTES)}` : raw;
      } catch {
        // Best-effort: the spawn might have died before opening the fd.
      }
      const messageBase = `OpenKnowledge server did not bind a port within ${POLL_DEADLINE_MS}ms after ephemeral spawn (pid=${handle.pid}).`;
      throw Object.assign(
        new Error(stderrTail ? `${messageBase}\n--- stderr ---\n${stderrTail}` : messageBase),
        {
          name: 'SpawnLockTimeoutError' as const,
          kind: 'spawn-lock-timeout' as const,
          pid: handle.pid,
          ...(stderrTail !== undefined && { stderrTail }),
        },
      );
    }

    const port = lock.port;
    const apiOrigin = `http://localhost:${port}`;
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
        `--ok-collab-url=ws://localhost:${port}/collab`,
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
      ],
      title: formatEditorTitle(projectName),
    });

    const disposeShowGate = this.deps.showGate.register(window, { kind: 'editor' });

    try {
      if (this.deps.rendererDevUrl) {
        await window.loadURL(this.deps.rendererDevUrl);
      } else {
        await window.loadFile(this.deps.rendererEntryPath);
      }
    } catch (err) {
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

    window.on('closed', () => {
      disposeShowGate();
      // Ownership guard — only tear down if THIS window still owns the slot. A
      // focus-dedup re-open or `stopAllOwnedServers` could have replaced/cleared
      // the entry; without the guard we'd terminate a sibling's server or double
      // free. (Double teardown is itself safe — ESRCH + force-rm — but the guard
      // keeps the common path single-pass.)
      if (this.windowsByPath.get(canonicalKey) !== context) return;
      this.windowsByPath.delete(canonicalKey);
      // Fire-and-forget: the `'closed'` event handler is synchronous. Terminate
      // the server THEN remove the temp dir (sequential — see
      // `teardownEphemeralSession`).
      void this.teardownEphemeralSession(
        context.ephemeral as NonNullable<ProjectContext['ephemeral']>,
      );
    });

    this.windowsByPath.set(canonicalKey, context);
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
   */
  private async teardownEphemeralSession(session: {
    projectDir: string;
    pid: number;
    lockDir: string;
  }): Promise<void> {
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
          err: err instanceof Error ? err.message : String(err),
          projectDir: session.projectDir,
        },
        '[window-manager] failed to remove ephemeral temp dir',
      );
    });
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
        { err: (err as Error).message, projectPath },
        'utility shutdown IPC failed in closeProjectWindow (likely already exited)',
      );
    }
    return true;
  }

  /**
   * Poll `<lockDir>/server.lock` until a valid lock appears with `port > 0`
   * and a known `kind`, or until `deadlineMs` elapses. Used by the detached-
   * spawn path to wait for the freshly-spawned CLI to bind a port and write
   * its lock atomically (the lock writer in `bootServer` only flips port from
   * `0` to the bound port after `httpServer.listen` resolves, so seeing
   * `port > 0` is the readiness signal).
   *
   * Returns the parsed lock metadata on success, or `null` on timeout. When
   * `readServerLock` is not wired in `deps` (back-compat with tests that
   * don't exercise the detached path), returns `null` immediately — the
   * caller propagates that as a spawn-failure error.
   *
   * Polling cadence: 50 ms. Uses `deps.setTimeout` so test injections that
   * fire the timer synchronously make the loop deterministic.
   */
  private async pollServerLock(
    lockDir: string,
    deadlineMs: number,
  ): Promise<ServerLockMetadataLike | null> {
    const POLL_INTERVAL_MS = 50;
    const reader = this.deps.readServerLock;
    if (!reader) return null;
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const lock = reader(lockDir);
      // A draining lock is the PREDECESSOR still exiting, not the fresh
      // spawn's readiness signal — keep polling until the successor's
      // (non-draining) lock appears.
      if (lock !== null && lock.draining !== true && lock.port > 0 && lock.kind !== undefined) {
        return lock;
      }
      await new Promise<void>((resolveSleep) => {
        this.deps.setTimeout(() => {
          resolveSleep();
        }, POLL_INTERVAL_MS);
      });
    }
    return null;
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
    if (lock.port <= 0) return refuse('lock-port-zero');
    if (lock.kind === undefined) return refuse('legacy-lock-no-kind');
    if (lock.capabilities !== undefined && !lock.capabilities.includes('ws')) {
      return refuse('capabilities-missing-ws');
    }
    return lock;
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
  private async probeAttachableLock(lock: ServerLockMetadataLike): Promise<boolean> {
    const probe = this.deps.probeWsUpgrade;
    if (!probe) return true;
    const url = `ws://localhost:${lock.port}/collab/__attach_probe__`;
    let upgradeOk = false;
    try {
      upgradeOk = await probe(url, 500);
    } catch {
      upgradeOk = false;
    }
    if (!upgradeOk) {
      this.deps.log?.warn(
        { event: 'desktop-attach-refused', reason: 'ws-upgrade-failed', lockPid: lock.pid },
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
    pendingDeepLinkTarget?: { kind: 'doc' | 'folder'; path: string };
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
    const apiOrigin = `http://localhost:${port}`;

    this.deps.log?.info(
      { projectPath, holderPid: lock.pid, port, startedAt: lock.startedAt },
      'attaching to existing OpenKnowledge server',
    );

    // Startup waterfall: the lock is readable on entry — record its `startedAt`.
    // Idempotent on the waterfall side (first write wins) so the detached-spawn
    // path's earlier mark is preserved when this is reached via spawn.
    this.deps.startup?.markServerLockReady?.({ startedAt: lock.startedAt, apiOrigin });

    const window = this.deps.createWindow({
      additionalArguments: [
        `--ok-collab-url=ws://localhost:${port}/collab`,
        `--ok-api-origin=${apiOrigin}`,
        `--ok-project-path=${projectPath}`,
        `--ok-project-name=${projectName}`,
        `--ok-mode=editor`,
        `--ok-app-version=${this.deps.appVersion}`,
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
    });
    this.deps.startup?.markWindowCreated?.();

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
    this.windowsByPath.set(canonicalKey, context);
    return context;
  }
}
