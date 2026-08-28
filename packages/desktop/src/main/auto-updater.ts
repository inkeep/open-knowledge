/**
 * Auto-updater — main-process orchestration for electron-updater.
 *
 * Boots at the end of `app.whenReady()`; tears down on `app.on('will-quit')`.
 * Every time-dependent path (now, setTimeout, clearTimeout, random) and every
 * Electron boundary (autoUpdater, BrowserWindow, ipcMain, app.isPackaged,
 * app.getVersion) is injectable so the module unit-tests under bun without
 * a real Electron runtime.
 *
 * Six events subscribed: checking-for-update, update-available,
 * update-not-available, download-progress (debug log only), update-downloaded,
 * error. Not wired: login, update-cancelled, appimage-filename-updated.
 *
 * Error routing: classified `ERR_UPDATER_*` / `HTTP_ERROR_*` → silent retry
 * + structured bracket log. Unclassified (bare Squirrel.Mac Error) → same
 * silent path with full err.stack. Zero user-visible signal per-error; the
 * stuck-hint closes the escape hatch after 7 consecutive failed days.
 *
 * Cadence: `checkForUpdates()` at boot, then a self-rescheduling timer that
 * fires every `UPDATE_CHECK_INTERVAL_MS` (hourly) plus a fresh per-fire
 * random jitter in `[0, UPDATE_CHECK_JITTER_MS)` (~5 min). The jitter
 * de-correlates the install base so a release day doesn't pile every client
 * onto GitHub's release-metadata endpoint in the same wall-clock instant (no
 * thundering herd). Singleton per app launch — one timer process-wide, not one
 * per project window: Electron has a single main process; project windows run
 * their own utility processes but none of them runs the updater.
 */

import type { OutgoingHttpHeaders } from 'node:http';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { EventChannels } from '../shared/ipc-events.ts';
import { createHandler } from '../shared/ipc-handler.ts';
import { type SendableWebContents, sendToRenderer } from '../shared/ipc-send.ts';
import {
  classifyInstallFailure,
  type LinuxManualInstallContext,
  manualInstallPlanFor,
} from './linux-install-fallback.ts';
import type { AppState, UpdateChannel } from './state-store.ts';

/** GitHub provider coordinates — must match `electron-builder.yml` `publish:`. */
const GITHUB_OWNER = 'inkeep';
const GITHUB_REPO = 'open-knowledge';

// ————————————————————————————————————————————————————————
// Types + injection seams
// ————————————————————————————————————————————————————————

/**
 * Minimal shape the module needs from electron-updater's AppUpdater.
 * Production binding wraps the real `autoUpdater` singleton; tests pass a
 * stub subclass that exposes `emit()`.
 */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel: string | null;
  /** No beta channel — locked via explicit set alongside `channel`. */
  allowPrerelease: boolean;
  /** No downgrade path — locked via explicit set. */
  allowDowngrade: boolean;
  /**
   * electron-updater gates `checkForUpdates()` on `app.isPackaged ||
   * forceDevUpdateConfig`. The mock-update smoke runs against an
   * unpackaged dev build, so we flip this to `true` when `forceDevBypass`
   * is set so the manifest fetch actually proceeds. Packaged builds leave
   * this `false`.
   */
  forceDevUpdateConfig: boolean;
  /**
   * Override the feed URL at runtime. smoke passes a bare string
   * pointing at a local HTTP server (routed through `GenericProvider`). The
   * proxy-feed path passes a `generic` options object; the GitHub fallback
   * passes a `github` one. With the proxy off, production leaves this unset
   * and the updater reads the `publish:` block from `app-update.yml`.
   */
  setFeedURL(
    urlOrOptions:
      | string
      | { provider: 'generic'; url: string }
      | { provider: 'github'; owner: string; repo: string },
  ): void;
  /**
   * Per-request headers electron-updater attaches to every feed + artifact
   * request. Set to tag update fetches with the current version + channel
   * when the feed is pointed at the openknowledge.ai proxy; reset to null on
   * the GitHub fallback.
   */
  requestHeaders: OutgoingHttpHeaders | null;
  on(event: 'checking-for-update', listener: () => void): this;
  on(event: 'update-available', listener: (info: { version?: string }) => void): this;
  on(event: 'update-not-available', listener: (info: { version?: string }) => void): this;
  on(
    event: 'download-progress',
    listener: (info: { percent?: number; bytesPerSecond?: number }) => void,
  ): this;
  on(
    event: 'update-downloaded',
    listener: (info: { version?: string; downloadedFile?: string }) => void,
  ): this;
  on(event: 'error', listener: (err: Error & { code?: string }) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
  checkForUpdates(): Promise<unknown>;
  /**
   * Manually trigger a download. Required because `autoDownload` is `false`:
   * we gate downloads on the channel-match check inside `update-available`
   * so a cross-channel offer (e.g. electron-updater's GitHub-provider
   * cascade from `beta-mac.yml` to `latest-mac.yml`) never installs on the
   * wrong channel. The promise resolves to electron-updater's internal
   * file-info / path object; we don't read it.
   */
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

/** Minimal `ipcMain` surface — ipcMain.removeHandler() for teardown. */
export interface IpcMainLike extends Pick<IpcMain, 'handle' | 'removeHandler'> {}

/** Injectable `setTimeout` / `clearTimeout` for deterministic tests. */
interface Clock {
  setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

/**
 * `onDispatch` observability — invoked after every event-handler outcome so
 * tests can assert which code path fired. Production passes undefined.
 */
export type DispatchKind =
  | 'update-downloaded-toast-a'
  | 'update-downloaded-deduped'
  | 'update-downloaded-empty-version'
  | 'whats-new-toast-b'
  | 'whats-new-dismiss-broadcast'
  | 'stuck-hint-toast-c'
  | 'check-success'
  | 'error-classified'
  | 'error-unclassified'
  | 'relaunch-now'
  | 'relaunching-broadcast'
  | 'relaunch-failed-rearm'
  | 'relaunch-error-event'
  | 'relaunch-watchdog-fired'
  | 'skipped-dev-mode'
  | 'stale-pending-cleared'
  | 'attempted-install-reconciled'
  | 'install-in-flight-deferred'
  | 'install-never-committed-reoffered'
  | 'install-failed-on-boot'
  | 'install-failed-giveup'
  | 'attempted-install-cross-channel'
  | 'cross-channel-blocked'
  | 'staged-cache-reclaimed'
  | 'linux-manual-fallback-no-auth'
  | 'linux-manual-fallback-after-error'
  | 'download-skipped-already-staged'
  | 'download-skipped-install-armed'
  | 'relaunch-refresh-found-newer'
  | 'relaunch-refresh-up-to-date'
  | 'relaunch-refresh-timed-out'
  | 'relaunch-awaited-in-flight-staging'
  | 'relaunch-double-invoke-blocked'
  | 'toast-a-deferred-post-update-quiet'
  | 'toast-a-quiet-window-elapsed';

interface StartAutoUpdaterOpts {
  updater: UpdaterLike;
  ipcMain: IpcMainLike;
  readState: () => AppState;
  writeState: (next: AppState) => void;
  /**
   * Single target for the one-shot prompt that shouldn't multiply across
   * windows — Toast C (stuck-hint). The relaunch banner (Toast A) and the
   * release-notes notice (Toast B) both fan out to every window via
   * `getAllWindows` instead. Production passes
   * `() => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null`.
   * Returns null if no window is open (the broadcast no-ops; the state gate
   * still arms so the prompt doesn't re-emit once a window opens).
   */
  getPrimaryWindow: () => { webContents: SendableWebContents } | null;
  /**
   * Fan-out target for the relaunch banner (Toast A), the release-notes notice
   * (Toast B), and its cross-window dismiss — a staged update and "what's new"
   * should be visible from whichever window the user is looking at, and a
   * dismiss must reach every window. Multiplying these is safe: relaunch is
   * idempotent (`ok:update:relaunch-now` clears `versionPendingInstall` before
   * `quitAndInstall()`), and the release-notes dismiss is keyed by version so
   * repeats are no-ops. Optional: when omitted (e.g. unit-style fixtures),
   * these fall back to the single `getPrimaryWindow`.
   * Production passes `() => BrowserWindow.getAllWindows()`.
   */
  getAllWindows?: () => readonly { webContents: SendableWebContents }[];
  getAppVersion: () => string;
  isPackaged: boolean;
  /**
   * Host platform, injected so the platform-agnostic unit suite (which runs
   * on ubuntu CI) can pin any platform's behavior deterministically instead
   * of inheriting the runner's. Production omits it (`process.platform`).
   * Drives the Linux install-on-quit carve-out — see the
   * `autoInstallOnAppQuit` assignment.
   */
  platform?: NodeJS.Platform;
  /** True when `OK_UPDATER_FORCE_DEV=1` — lets smoke harness opt in. */
  forceDevBypass?: boolean;
  /**
   * smoke override — when set, call `updater.setFeedURL(feedUrl)`
   * before the first check. Forwards the bare string to electron-updater's
   * `GenericProvider`. Production leaves this unset (the updater reads the
   * `publish: github` block from `app-update.yml` / `electron-builder.yml`).
   * Wired from `OK_UPDATER_FEED_URL` env var at main-process boot.
   */
  feedUrl?: string;
  /**
   * Point electron-updater's feed at the openknowledge.ai update proxy (a thin
   * 302 to GitHub) so updates are counted per version, tagging each request
   * with the current version + channel. Active only when the build's channel is
   * in `channels`; default-off — production passes an empty set until the proxy
   * is verified live, then flips to `['beta']` and later `['latest']`. A dev
   * `feedUrl` override takes precedence. On a feed failure, the first check
   * reverts to the GitHub provider for the session.
   */
  proxyFeed?: { base: string; channels: ReadonlySet<UpdateChannel> };
  /**
   * Optional scheduler for events that might fire before the renderer
   * finishes mounting its subscribers. Toast B (first-launch version
   * notice) is affected — `startAutoUpdater` runs from `app.whenReady()`
   * and dispatches Toast B synchronously, which races the renderer's
   * React mount of `<UpdateToast/>`. Electron drops `webContents.send`
   * messages that arrive before the renderer has attached its listener
   * (the docs call out this race for `send` but not `handle`). Production
   * wires this to `win.webContents.once('did-finish-load', fn)` on the
   * primary window so Toast B lands after the renderer is listening.
   * Tests can pass `undefined` (or an immediate-fire scheduler) and get
   * the pre-fix behavior. Toast A + Toast C don't need the deferral —
   * they fire off subsequent electron-updater events (update-downloaded,
   * error), which by definition arrive long after the renderer mount.
   */
  whenRendererReady?: (fn: () => void) => void;
  /**
   * Synchronous teardown hook fired immediately before
   * `autoUpdater.quitAndInstall()` from the `ok:update:relaunch-now`
   * IPC handler. Production wires this to a hard SIGKILL of every
   * project-window utility process.
   *
   * What this buys is server lifetime, not ShipIt's pre-swap validation. A
   * detached server survives app-quit by design, and one that outlives the
   * swap is re-attached by the relaunched app, which then reads an older
   * version off `server.lock` and shows the version-drift toast. The graceful
   * `{type:'shutdown'}` window-close IPC is not fast enough on its own —
   * Hocuspocus drain plus file-watcher teardown can outlast the swap window.
   *
   * ShipIt's `SQRLInstallerErrorAppStillRunning` abort is NOT the reason, and
   * restating it here would be wrong: `SQRLInstaller.m` enumerates
   * `NSRunningApplication runningApplicationsWithBundleIdentifier:` and keeps
   * only entries whose `bundleURL` standardizes to the target `.app`, so a
   * `utilityProcess` fork (not an application at all) and the detached server
   * (a distinct helper bundle under `Contents/Frameworks/`) are both filtered
   * out. Only a second GUI instance of the installed bundle can trip it.
   *
   * Optional so unit tests don't
   * have to provide one — production passes
   * `async () => await windowManager.stopAllOwnedServers()`. May be
   * async — the hook is awaited before `quitAndInstall` so a two-phase
   * shutdown (SIGTERM → poll → SIGKILL) can complete cleanly.
   */
  prepareForRelaunch?: () => void | Promise<void>;
  /**
   * Reclaim electron-updater's staged-installer cache (`pending/` under the
   * updater cache dir). Invoked once per boot, from the reconciliation
   * section, ONLY when no install commitment remains armed — i.e.
   * `versionPendingInstall` and `attemptedInstall` are both null after
   * reconciliation and the boot did not just give up on a failing install.
   * That timing is load-bearing: a staged-but-uncommitted update (the Linux
   * download-then-quit shape) and a failed or dismissed install must keep
   * their installer on disk — the Linux manual-install fallback hands the
   * user a command that points into that cache. electron-updater itself only
   * empties `pending/` when a DIFFERENT version is later downloaded, so
   * without this hook the installer for the version already running sits
   * there (~250 MB) until the next release. Production passes
   * `reclaimPendingUpdateCache` (packaged builds only); errors are logged
   * and swallowed — reclaim must never break boot.
   */
  reclaimStagedUpdateCache?: () => undefined | Promise<unknown>;
  /**
   * Linux-only manual-install fallback surface. The Linux installers run a
   * BLOCKING privileged package install inside `quitAndInstall()` behind a
   * graphical auth wrapper (pkexec + a PolicyKit agent, gksudo, …); on
   * minimal desktops with no such wrapper, electron-updater falls back to
   * terminal `sudo`, which cannot prompt in a GUI launch. When provided:
   *
   *   - `hasGraphicalAuth` preflights the "Relaunch now" click. If it
   *     reports false (and the staged installer is a recognized package),
   *     `quitAndInstall()` is skipped entirely and
   *     `showManualInstallFallback` fires instead, with the staged state
   *     left armed so the update survives dismissal and relaunch.
   *   - An install that DID run but failed with anything other than an
   *     explicit user cancellation (pkexec exit 126) also triggers the
   *     fallback, after the normal `failRelaunch` window recovery.
   *
   * Production wires `showManualInstallFallback` to the dismissible
   * Copy-command / Relaunch / Not-now dialog in
   * `linux-install-fallback.ts`. Never set on other platforms.
   */
  linuxInstallSupport?: {
    hasGraphicalAuth: () => boolean;
    showManualInstallFallback: (ctx: LinuxManualInstallContext) => undefined | Promise<unknown>;
    /**
     * Existence check for the persisted staged-installer path — state can
     * outlive the file (a hand-cleared cache). Production passes an
     * `existsSync` wrapper; optional so unit fixtures keep the pre-check
     * behavior. A missing file falls through to the default
     * electron-updater path instead of offering a command that would fail.
     */
    stagedInstallerExists?: (path: string) => boolean;
  };
  /**
   * Surface the result of a menu-driven `Check for Updates…` click. The
   * periodic hourly check stays silent on a no-change outcome so users
   * aren't spammed every hour, but a manual click is an explicit user
   * action that needs feedback. Production wires this to
   * `dialog.showMessageBox` from main, which renders the standard
   * macOS info dialog ("You're on the latest version") that Apple HIG
   * apps use for this same gesture.
   *
   * Fires once per `ok:update:check-now` IPC: from whichever of
   * `update-available`, `update-not-available`, or `error` lands first
   * after the check, OR from the `checkForUpdates()` rejection handler
   * if the underlying call throws synchronously.
   */
  showCheckNowResult?: (result: CheckNowResult) => void;
  clock?: Clock;
  now?: () => Date;
  /**
   * Injectable RNG for the periodic-check jitter — production passes
   * `Math.random`; tests pass a deterministic stub (`() => 0` for the exact
   * hourly floor, `() => 0.5` for floor + half the jitter window) so the
   * scheduled delay is assertable. Called once per (re)schedule, so a stub
   * that returns a different value each call exercises the per-fire
   * re-randomization that breaks fleet lockstep.
   */
  random?: () => number;
  onDispatch?: (kind: DispatchKind) => void;
  logger?: Logger;
}

/**
 * Outcome of a single menu-driven update check, delivered to
 * `StartAutoUpdaterOpts.showCheckNowResult`. Renderer/main is free to
 * pick the surface (modal dialog, toast, both) — the contract is just
 * the discriminated union.
 */
type CheckNowResult =
  | { kind: 'available'; currentVersion: string; latestVersion: string }
  /**
   * A build is already staged and waiting, so the offer this check turned up
   * was declined rather than fetched — whether it was the staged version
   * re-offered or a newer one the single-flight guard turned down.
   * `stagedVersion` is what a relaunch will actually install, which in the
   * newer-offer case is NOT the version just offered: reporting the offer there
   * would promise a build this session has decided not to fetch, and reporting
   * either as "downloading" would describe a download that is not running.
   */
  | { kind: 'ready-to-install'; currentVersion: string; stagedVersion: string }
  | { kind: 'not-available'; currentVersion: string }
  | { kind: 'error'; message: string };

export interface StartAutoUpdaterHandle {
  destroy(): void;
  /**
   * Force an out-of-cadence `checkForUpdates()` — wired to the application
   * menu's "Check for Updates…" entry. Surfaces the outcome via
   * `showCheckNowResult` (a "you're up to date" / "update available" / error
   * dialog in production), so a manual click always gives explicit feedback —
   * unlike the silent periodic hourly check. The hourly timer continues
   * independently; this just triggers an extra check now. Returns the
   * underlying `checkForUpdates()` promise.
   */
  checkForUpdatesNow(): Promise<unknown>;
  /**
   * The release-notes (what's-new) notice currently live for this session, or
   * null when none is live (never fired, dismissed, or past its ~60s window).
   * `main/index.ts` re-sends it to a window opened after the notice first fired
   * so a project opened shortly after an update still shows the card.
   */
  getActiveWhatsNew(): { version: string; releaseUrl: string } | null;
  /**
   * True while the post-update quiet window is running, i.e. the user reached
   * this build recently enough that a fresh "ready to install" banner would
   * land on top of their update rather than after it.
   *
   * `main/index.ts` consults this before re-sending a pending banner to a
   * newly-opened window: without it, opening a project during the window would
   * surface the very notice the updater is holding back.
   */
  isWithinPostUpdateQuietWindow(): boolean;
  /**
   * Uninstall path: prevent a staged update from auto-installing on the quit
   * that hands control to the detached uninstall helper. Otherwise Squirrel.Mac
   * can swap/relaunch the bundle while the helper is trying to trash it.
   */
  suppressAutoInstallOnQuit(): void;
  /**
   * Record that this quit is where the staged install gets handed off, so the
   * next boot can tell "the install may still be running" from "the install
   * failed". Wired to `app.on('before-quit')`: with install-on-quit armed an
   * ordinary quit IS the commit point, and it is the last moment a live process
   * can observe it — the swap runs after the exit, in a process no later boot
   * can see. The stamp is also what separates "this install began" from "no
   * install ever began": without it the boot cannot time the attempt at all and
   * re-offers the staged update instead of judging it.
   *
   * Stamps once per armed attempt. A quit that re-hands off an attempt an
   * earlier quit already handed off buys no fresh tolerance: otherwise a user
   * who reopens promptly after every quit would keep resetting the clock on a
   * genuinely broken installer and never be told about it. A "Relaunch now"
   * click does re-stamp — that is an explicit request for a fresh attempt, and
   * the surfacing budget bounds how many of those can pass silently.
   */
  recordInstallHandoffOnQuit(): void;
}

interface Logger {
  info(msg: string, ctx?: object): void;
  warn(msg: string, ctx?: object): void;
  error(msg: string, ctx?: object): void;
  debug(msg: string, ctx?: object): void;
}

const DEFAULT_CLOCK: Clock = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (h) => {
    globalThis.clearTimeout(h);
  },
};

const DEFAULT_LOGGER: Logger = {
  info: (msg, ctx) => console.info('[updater]', msg, ctx ?? ''),
  warn: (msg, ctx) => console.warn('[updater]', msg, ctx ?? ''),
  error: (msg, ctx) => console.error('[updater]', msg, ctx ?? ''),
  debug: (msg, ctx) => console.debug('[updater]', msg, ctx ?? ''),
};

/**
 * Base interval between periodic update checks — the floor; the actual delay
 * before each check is `UPDATE_CHECK_INTERVAL_MS + random()*UPDATE_CHECK_JITTER_MS`
 * (see `UPDATE_CHECK_JITTER_MS`), so a check never lands sooner than this after
 * the previous one.
 *
 * Hourly, matching Obsidian's cadence. A check's manifest poll is cheap, but on
 * the beta channel it resolves through a docs-site proxy that calls GitHub's
 * unauthenticated List Releases API (60 req/hr, keyed on the proxy's shared
 * egress IP, not the client's) to find the newest prerelease. Client poll
 * frequency therefore feeds into one shared, fleet-wide budget rather than a
 * per-client one; a short cache on the proxy softens that coupling but does not
 * remove it. An hour keeps the whole install base clear of the limit; a shorter
 * interval buys only faster update pickup, not worth spending the rate-limit
 * headroom on. Stable is unaffected (it resolves via GitHub's `releases/latest`
 * web redirect, no API).
 */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Upper bound on the random jitter added to each periodic-check delay. A fresh
 * value in `[0, UPDATE_CHECK_JITTER_MS)` is drawn per fire and added to
 * `UPDATE_CHECK_INTERVAL_MS`, so checks land somewhere in
 * `[UPDATE_CHECK_INTERVAL_MS, UPDATE_CHECK_INTERVAL_MS + 5 min)` after the
 * previous one — never sooner than the base interval, but spread across a
 * ~5-minute window so an install base that booted together (or all woke from
 * sleep at the same wall-clock instant) doesn't re-synchronize onto GitHub's
 * release-metadata endpoint. Kept a small fraction of the base interval so
 * "hourly" still roughly holds. Breaking lockstep matters on the beta channel:
 * a synchronized fleet collapses the per-instance manifest-poll spread that
 * keeps the shared GitHub API budget (see `UPDATE_CHECK_INTERVAL_MS`) from
 * spiking in any one window.
 */
export const UPDATE_CHECK_JITTER_MS = 5 * 60 * 1000;

/**
 * How long after a clean `quitAndInstall()` return the process may stay alive
 * before the relaunch is declared failed. The slow part of a relaunch (server
 * teardown) happens BEFORE quitAndInstall via `prepareForRelaunch`; what's
 * left is just the app quitting (the Squirrel swap runs in ShipIt after the
 * process exits), which takes seconds. A false positive — the watchdog fires,
 * then the app quits anyway — self-heals: the restored
 * `versionPendingInstall` is cleared by the boot-time stale-pending
 * reconciliation once the relaunched app reports the new version.
 */
export const RELAUNCH_WATCHDOG_MS = 15_000;

/** 7 calendar days before the stuck-hint toast fires. */
export const STUCK_HINT_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many times the boot-time "update didn't install" notice is surfaced for a
 * single `attemptedInstall` before the record is dropped and the notice goes
 * quiet. `attemptedInstall` only clears once the running version reaches it, so
 * without this bound a persistently-failing ShipIt or an unreachable attempted
 * version (a yanked release, a channel move) would re-fire the card on every
 * boot forever. The 7-day stuck-hint (Toast C) stays the backstop signal after
 * the budget is spent.
 */
export const INSTALL_FAILURE_MAX_SURFACES = 3;

/**
 * How long after an install was handed off a boot still treats a running
 * version that has not caught up as "the install may be underway" rather than
 * as a failure. The swap runs after the app exits, in a process no later boot
 * can observe, so elapsed time is the only discriminator available — and
 * reopening mid-install boots the OLD version, which is the expected state
 * inside that window rather than evidence of anything.
 *
 * Calibrated well above the observed install tail (successful installs have run
 * ~1s to ~4.5 min) so a slow-but-healthy install is not condemned, and well
 * below a working session so a genuinely dead install is still reported the
 * same day. Widening it delays a true notice by a boot; narrowing it re-opens
 * the false-positive window. `handoffAgeMs` on the failure logs is the field
 * evidence needed to move it.
 *
 * The window is measured from the handoff both install paths record — the
 * "Relaunch now" click, or the quit install-on-quit commits on. The boot
 * reconciliation reaches this window only with a stamp on record: an attempt
 * with none never began, so it is re-offered rather than timed. The staging
 * fallback in `installMayStillBeRunning` therefore matters only to that
 * function's other caller, crash detection, which asks before the
 * reconciliation has run.
 */
const INSTALL_IN_FLIGHT_GRACE_MS = 30 * 60 * 1000;

/**
 * How many boots may hold the failed-install verdict on the grounds that the
 * install might still be running, before the verdict is decided on its merits
 * however recent the handoff looks.
 *
 * The handoff moment cannot bound the hold by itself. electron-updater re-fires
 * `update-downloaded` from its on-disk cache on every launch check, and that
 * re-arm clears the recorded handoff whenever the pending gate is not already
 * set for the same version — after a "Relaunch now" click, and on every boot of
 * a same-major.minor.patch bump, whose stale-pending reconciliation strips the
 * gate. The next quit then stamps a fresh moment, so an install that never lands
 * keeps looking newly handed off to anyone whose quit-to-reopen gaps stay inside
 * the tolerance, and the notice would never arrive. The count is the part of the
 * hold that survives that re-arm, which is what makes it the termination
 * guarantee; three mirrors the surfacing budget's shape.
 */
const INSTALL_DEFER_MAX_BOOTS = 3;

/**
 * "Download manually" target for the stuck-hint and boot-detected install-failed
 * notices. Points at the GitHub Releases index, the canonical home of the signed
 * installers and the same host used by `releaseUrlFor`. The
 * index page, unlike a version-specific tag URL, is guaranteed to exist and lists
 * the latest download at the top, so the manual-download escape hatch can never
 * itself 404.
 */
export const STUCK_HINT_DOWNLOAD_URL = 'https://github.com/inkeep/open-knowledge/releases';

/**
 * How long the click-gated freshness check waits for the manifest poll to
 * resolve before giving up and installing what is already staged.
 *
 * The user has already clicked "Relaunch" and the window is showing an
 * in-progress card, so this is dead time they are watching. A manifest poll is
 * a single small GET (CDN-cached at the update proxy), so a few seconds covers
 * a healthy round trip with slack; past that, a stale-but-working install
 * beats an app that appears hung. Timing out is not an error — it falls
 * through to the existing staged version.
 */
export const RELAUNCH_REFRESH_CHECK_MS = 4_000;

/**
 * How long the click-gated refresh waits for a newer build to finish
 * downloading and staging before falling back.
 *
 * Two distinct jobs, which is why it is minutes rather than seconds. It bounds
 * the wait for a download the refresh itself started, AND the wait for a
 * download that was already in flight when the click landed. The second is the
 * safety-critical one: `quitAndInstall()` during a re-stage hands Squirrel a
 * half-written staging directory, so waiting here is what keeps the install
 * from failing.
 *
 * Sized for a full update zip on a slow connection. On expiry the click falls
 * through and installs whatever was already staged, which stays safe for the
 * whole download: electron-updater writes to a temp file and only hands the
 * result to Squirrel once the download completes, so an unfinished re-download
 * has not disturbed the previous bundle or the proxy server still serving it.
 * The dangerous window is the handoff itself, and that is covered by treating
 * download and stage as one in-flight unit.
 */
export const RELAUNCH_REFRESH_DOWNLOAD_MS = 120_000;

/**
 * How long after arriving on a new version the "ready to install" banner stays
 * suppressed.
 *
 * At the release cadence this app ships, the newest build is often superseded
 * inside a single check interval, so the boot check that runs on an update
 * relaunch routinely finds another version and re-arms the banner within
 * seconds of the user finishing an update. Worse, that banner outranks the
 * "Updated to Version X" confirmation in the notice priority order, so the
 * acknowledgement is not merely followed by another demand, it is replaced by
 * one.
 *
 * Suppression costs nothing: the update still downloads, still stages, and
 * still installs at the next natural quit via `autoInstallOnAppQuit`. Only the
 * interruption is deferred, and only until the user has had a stretch of
 * uninterrupted use. If the app is still running when the window elapses, the
 * banner appears then.
 */
export const POST_UPDATE_QUIET_MS = 10 * 60 * 1000;

/**
 * How long the release-notes (what's-new) notice stays "live" for late-opened
 * windows: main re-sends it to a window opened within this window of the notice
 * first firing, and stops once it elapses. Mirrors the renderer's per-card
 * auto-dismiss (`WHATS_NEW_AUTO_DISMISS_MS` in `UpdateNotices.shared.ts`) — keep
 * the two in sync; TypeScript can't, since main can't import the renderer module.
 */
const WHATS_NEW_LIVE_WINDOW_MS = 60_000;

/**
 * GitHub Releases tag URL shape for the "what's new" toast.
 *
 * `version` is `app.getVersion()` (trusted, read from package.json at boot),
 * but encode defensively so a malformed version string (containing `/` or
 * `..`) cannot produce a path-confusion URL.
 */
export function releaseUrlFor(version: string): string {
  return `https://github.com/inkeep/open-knowledge/releases/tag/v${encodeURIComponent(version)}`;
}

/** Classified `err.code` prefixes. */
export function isClassifiedUpdaterError(err: unknown): err is Error & { code: string } {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return code.startsWith('ERR_UPDATER_') || code.startsWith('HTTP_ERROR_');
}

/**
 * Apply the channel-derived updater config (`channel`, `allowPrerelease`,
 * `allowDowngrade`) given a desired channel. Pure: a thin wrapper around
 * three property writes — exported so the boot path can apply the
 * build-derived channel and the unit tier can pin the per-channel config.
 *
 * Channels are install-time sticky: a beta DMG only auto-updates to a
 * newer beta DMG, a stable DMG only to a newer stable DMG. Cross-channel
 * moves are user-initiated reinstalls, so `allowDowngrade` is `false` on
 * both branches — there is no legitimate auto-downgrade path. The actual
 * cross-channel block lives in the `update-available` handler (which
 * vetoes any offered version whose channel disagrees with the running
 * build); these settings are belt-and-braces against the GitHub
 * provider's `beta-mac.yml`→`latest-mac.yml` cascade.
 *
 * Setter ordering is load-bearing: electron-updater's `channel` setter
 * unconditionally force-enables `allowDowngrade`
 * as a side effect, regardless of which value is being set. Applying
 * `allowDowngrade` AFTER `channel` guarantees the post-state matches the
 * desired `false` on both branches.
 */
export function applyChannelSettings(
  updater: Pick<UpdaterLike, 'channel' | 'allowPrerelease' | 'allowDowngrade'>,
  channel: UpdateChannel,
): void {
  updater.channel = channel;
  updater.allowPrerelease = channel === 'beta';
  updater.allowDowngrade = false;
}

/**
 * Derive the auto-update channel implied by the running build's version
 * string — beta DMGs are cut with a prerelease semver tag (`0.4.0-beta.36`),
 * stable DMGs publish a plain `X.Y.Z`. This is the SOLE source of truth for
 * the channel: there is no persisted preference and no in-app toggle.
 *
 * A version that fails to parse (which would never happen — `app.getVersion()`
 * reads a build-time-baked package.json) defaults to `'latest'`: the
 * conservative choice that keeps a malformed-version build on the stable feed
 * rather than the prerelease one.
 */
export function channelFromVersion(version: string): UpdateChannel {
  if (typeof version !== 'string' || version === '') return 'latest';
  const stripped = version.split('+', 1)[0] ?? version;
  const match = /^\d+\.\d+\.\d+(?:-([\w.-]+))?$/.exec(stripped);
  if (!match) return 'latest';
  return match[1] ? 'beta' : 'latest';
}

/**
 * Major.minor.patch version compare. Drops prerelease + build suffix and
 * compares the (major, minor, patch) tuple numerically; returns true when
 * `running` >= `pending`. Both inputs come from trusted sources
 * (app.getVersion() and electron-updater's manifest), so a malformed input
 * falls through to `false` — the conservative default that keeps
 * versionPendingInstall armed rather than clearing on garbage.
 *
 * MMP-only is deliberate: "0.4.1" and "0.4.1-beta.5" compare equal. Acceptable
 * for the clear-on-boot use case — if the pending file is genuinely still
 * staged, electron-updater's next periodic check will re-emit update-downloaded
 * and re-arm the gate.
 */
/**
 * Build the `CheckNowResult` surfaced to `showCheckNowResult` for an updater
 * error. Shared by both error-delivery paths: the `error` event emitted by
 * electron-updater (the common path) and the synchronous-reject from
 * `checkForUpdates()` (the rare path covering provider-construction failures
 * before the event bus is attached). Centralizing the special-case keeps the
 * race-window remap uniform regardless of how the error is delivered — a
 * future electron-updater that re-routes `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`
 * through promise rejection still produces the friendly "up to date" dialog.
 *
 * See the `onError` site for the full rationale on why
 * `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` maps to `not-available` rather than
 * `error`.
 */
export function buildCheckNowResultFromError(err: unknown, currentVersion: string): CheckNowResult {
  const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') {
    return { kind: 'not-available', currentVersion };
  }
  const message =
    err instanceof Error
      ? err.message || 'Update check failed'
      : typeof err === 'string'
        ? err || 'Update check failed'
        : 'Update check failed';
  return { kind: 'error', message };
}

export function versionAtLeast(running: string, pending: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    if (typeof v !== 'string') return null;
    const stripped = v.split(/[-+]/, 1)[0] ?? v;
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(stripped);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const r = parse(running);
  const p = parse(pending);
  if (!r || !p) return false;
  if (r[0] !== p[0]) return r[0] > p[0];
  if (r[1] !== p[1]) return r[1] > p[1];
  return r[2] >= p[2];
}

/**
 * Prerelease-aware "did the running build reach (>=) the attempted version?"
 * used by the boot-time failed-install detection. Unlike `versionAtLeast`
 * (MMP-only, by design, for the phantom-toast clear), this MUST distinguish a
 * same-major.minor.patch beta bump — the dominant OK update shape — so a failed
 * `0.16.0-beta.1` → `0.16.0-beta.3` install is detectable rather than read as
 * "caught up". Follows semver §11 precedence: stable > any prerelease of the
 * same MMP; prerelease identifiers compared left-to-right (numeric numerically,
 * a numeric identifier ranks below a non-numeric one, fewer identifiers ranks
 * below more when all preceding are equal).
 *
 * Both inputs are trusted (`app.getVersion()` and electron-updater's manifest),
 * so an unparseable input returns `true` — the conservative default here is the
 * OPPOSITE of `versionAtLeast`'s: assume the install SUCCEEDED rather than fire
 * a spurious "update didn't install" notice on a version string we can't read.
 */
export function installReached(running: string, attempted: string): boolean {
  const parse = (v: string): { mmp: [number, number, number]; pre: string[] } | null => {
    if (typeof v !== 'string') return null;
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
    if (!m) return null;
    return {
      mmp: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: m[4] ? m[4].split('.') : [],
    };
  };
  const r = parse(running);
  const a = parse(attempted);
  if (!r || !a) return true;
  for (let i = 0; i < 3; i++) {
    if (r.mmp[i] !== a.mmp[i]) return (r.mmp[i] as number) > (a.mmp[i] as number);
  }
  // Equal MMP — compare prerelease precedence. No prerelease outranks any.
  if (r.pre.length === 0 && a.pre.length === 0) return true;
  if (r.pre.length === 0) return true; // running is stable, attempted is a prerelease
  if (a.pre.length === 0) return false; // running is a prerelease, attempted is stable
  const len = Math.min(r.pre.length, a.pre.length);
  for (let i = 0; i < len; i++) {
    const ri = r.pre[i] as string;
    const ai = a.pre[i] as string;
    if (ri === ai) continue;
    const rNum = /^\d+$/.test(ri);
    const aNum = /^\d+$/.test(ai);
    if (rNum && aNum) return Number(ri) > Number(ai);
    if (rNum !== aNum) return aNum; // numeric identifiers rank below non-numeric
    return ri > ai; // both non-numeric — ASCII order
  }
  return r.pre.length >= a.pre.length;
}

/**
 * How long ago the install for the armed attempt was handed off, given the
 * handoff instant a live process recorded before it quit. The boot that judges
 * the install runs in a different process than the install itself, so this is
 * the only elapsed time available to it.
 *
 * Returns null for timing that cannot be reasoned from, which callers must
 * treat as "no in-flight claim" rather than as a fresh install:
 *   - no `handoffAt` — nothing recorded the commit and no fallback moment
 *     survived either; the process that could have stamped it is gone.
 *   - negative elapsed — `Date.now()` is wall-clock, not monotonic, and this
 *     record crosses a process quit, so an NTP correction or a VM resume can
 *     leave the recorded handoff in the future. Same coercion the write side
 *     makes on the staging age.
 */
function installHandoffAgeMs(handoffAt: number | null, nowMs: number): number | null {
  if (handoffAt === null) return null;
  const elapsed = nowMs - handoffAt;
  return elapsed < 0 ? null : elapsed;
}

/**
 * The moment the in-flight window is measured from: the handoff a live process
 * recorded, or the staging moment when none did.
 *
 * One function rather than the `??` written at each site, because the verdict
 * and the log line that reports its inputs have to agree about which moment
 * they mean. They once did not: the predicate read a field the reconciliation
 * had already nulled while the log kept printing the pre-clear value, so a
 * report of the resulting false failure notice read as impossible.
 */
function resolveInstallHandoffMoment(state: AppState, stagedAt: number | null): number | null {
  return state.attemptedInstallHandoffAt ?? stagedAt;
}

/**
 * Whether an install this app committed to may still have been running at
 * `nowMs` — and, when it may, which version and from what moment.
 *
 * Two callers ask the same question for different reasons, which is why it is
 * a function rather than an inline condition. The boot reconciliation below
 * asks it to decide whether to condemn an install as failed. Crash detection
 * asks it to decide whether a session that ended without a clean quit was
 * killed by the installer rather than by a fault — the installer terminates the
 * running process to replace its files, which bypasses the quit sequence and
 * leaves the dirty-shutdown sentinel behind. Both need the claim
 * bounded the same way; two copies of the bound would drift, and the pair that
 * drifted would tell the user an install failed while telling them nothing
 * about the crash it caused, or the reverse.
 *
 * The bound is the interesting part, and neither half of it is optional. The
 * grace window keeps a stale record from claiming an install is in flight
 * forever; the boot count is what survives electron-updater re-arming
 * `update-downloaded` from its on-disk cache and clearing the handoff stamp,
 * which would otherwise make an install that never lands look perpetually
 * fresh. See both constants' own docs for the calibration.
 *
 * Returned as a value rather than a boolean so a caller can name the version in
 * a log line without re-reading state that the next moment may have cleared.
 *
 * `stagedAt` is a required parameter rather than a read of
 * `state.versionPendingInstallStagedAt`, and the difference is load-bearing.
 * The boot reconciliation runs the stale-pending clear BEFORE it reaches this
 * question, and that clear nulls the staging stamp — so by the time the verdict
 * is due, the field on `state` no longer holds the moment the artifact was
 * actually staged. On the shape where nothing else recorded the commit (an
 * unobserved quit, so no `attemptedInstallHandoffAt`) that field is the only
 * lower bound left, and reading the cleared one silently condemns an install
 * that is still running. Passing it in forces each caller to say which snapshot
 * it means: the reconciliation passes the value it captured before its own
 * mutation, and a caller reading fresh from disk passes the field as-is.
 */
export function installMayStillBeRunning(
  state: AppState,
  nowMs: number,
  stagedAt: number | null,
): { attemptedVersion: string; handoffAt: number; recordedHandoff: boolean } | null {
  const attempted = state.attemptedInstall;
  // Nothing was committed to, so nothing can be in flight.
  if (attempted === null) return null;
  const handoffAt = resolveInstallHandoffMoment(state, stagedAt);
  const handoffAgeMs = installHandoffAgeMs(handoffAt, nowMs);
  if (
    handoffAt === null ||
    handoffAgeMs === null ||
    handoffAgeMs > INSTALL_IN_FLIGHT_GRACE_MS ||
    state.attemptedInstallDeferredBoots >= INSTALL_DEFER_MAX_BOOTS
  ) {
    return null;
  }
  return {
    attemptedVersion: attempted,
    handoffAt,
    recordedHandoff: state.attemptedInstallHandoffAt !== null,
  };
}

// ————————————————————————————————————————————————————————
// Main entry
// ————————————————————————————————————————————————————————

export function startAutoUpdater(opts: StartAutoUpdaterOpts): StartAutoUpdaterHandle {
  const {
    updater,
    ipcMain,
    readState,
    writeState,
    getPrimaryWindow,
    getAllWindows,
    getAppVersion,
    isPackaged,
    platform = process.platform,
    forceDevBypass = false,
    feedUrl,
    proxyFeed,
    whenRendererReady,
    reclaimStagedUpdateCache,
    linuxInstallSupport,
    showCheckNowResult,
    clock = DEFAULT_CLOCK,
    now = () => new Date(),
    random = Math.random,
    onDispatch,
    logger = DEFAULT_LOGGER,
  } = opts;

  // `autoDownload = false` is load-bearing: we gate downloads on a
  // channel-match check inside `onUpdateAvailable` so a cross-channel offer
  // (e.g. electron-updater's GitHub-provider cascade from `beta-mac.yml` to
  // `latest-mac.yml` when the latest GitHub Release is a stable cut without
  // `beta-mac.yml`) never installs on the wrong channel. With autoDownload
  // true, electron-updater would download + stage + fire `update-downloaded`
  // before our `update-available` handler could veto, defeating the gate.
  updater.autoDownload = false;
  // Install-on-quit everywhere EXCEPT Linux. electron-updater's quit handler
  // fires from `app.once('quit')` — after every window is gone — and the
  // Linux installers (DebUpdater/RpmUpdater) run a BLOCKING pkexec install
  // right there, so a staged update would pop a windowless polkit password
  // prompt on an ordinary quit with nothing on screen to explain it.
  // Squirrel.Mac and NSIS install silently, so install-on-quit stays right
  // for them; Linux keeps only the explicit "Relaunch now" path, where the
  // user just clicked the button the prompt answers for.
  updater.autoInstallOnAppQuit = platform !== 'linux';
  // Channel = the build's self-identified channel from `app.getVersion()`.
  // No persisted preference, no IPC mutator — install-time-sticky: a beta
  // DMG only auto-updates to a newer beta DMG, a stable DMG only to a newer
  // stable. Setter ordering inside `applyChannelSettings` is load-bearing:
  // electron-updater's `channel` setter unconditionally
  // force-enables `allowDowngrade` as a side effect, so the explicit
  // `allowDowngrade = false` write lands AFTER `channel`.
  const buildChannel = channelFromVersion(getAppVersion());
  applyChannelSettings(updater, buildChannel);

  // smoke plumbing. When `forceDevBypass` is true we flip
  // `forceDevUpdateConfig` so `checkForUpdates()` actually hits the network
  // without a packaged `.app`. When `feedUrl` is set we point the updater at
  // a local HTTP server via electron-updater's `GenericProvider`. Production
  // leaves both unset — `isPackaged` + `publish: github` in `app-update.yml`
  // drives the real update path.
  updater.forceDevUpdateConfig = forceDevBypass;
  // Whether the openknowledge.ai proxy feed is active this session, so a feed
  // failure can revert to GitHub exactly once (see the first-check below).
  let usingProxyFeed = false;
  let proxyFallbackTried = false;
  if (feedUrl) {
    updater.setFeedURL(feedUrl);
    logger.info('setFeedURL (dev override) — updater will pull manifest from local mock', {
      feedUrl,
    });
  } else if (proxyFeed?.channels.has(buildChannel)) {
    // The /updates/{channel} route validates channel ∈ {stable, beta}; the
    // electron-updater 'latest' channel maps to the proxy's 'stable' path.
    const channelPath = buildChannel === 'beta' ? 'beta' : 'stable';
    updater.setFeedURL({ provider: 'generic', url: `${proxyFeed.base}/${channelPath}` });
    updater.requestHeaders = {
      'x-ok-from-version': getAppVersion(),
      'x-ok-channel': channelPath,
    };
    usingProxyFeed = true;
    logger.info('setFeedURL (proxy) — updater feed pointed at the openknowledge.ai proxy', {
      channel: channelPath,
    });
  }

  // User-visible update notices are a production-only surface. In an unpackaged
  // dev build the updater never downloads or installs anything (this is the same
  // expression that gates `checkForUpdates` below), so any persisted
  // `attemptedInstall` / `lastSeenVersion` drift is stale dev/test residue —
  // surfacing "Update to X didn't install" or a release-notes toast in a dev
  // window is pure noise. `forceDevBypass` (OK_UPDATER_FORCE_DEV=1) keeps the
  // manual update smoke able to observe the toasts in a dev build.
  const updatesEnabled = isPackaged || forceDevBypass;

  // One-shot reliability fallback: if the proxy feed fails the first check,
  // revert to the GitHub provider for the rest of the session so auto-update
  // never drops below "GitHub direct."
  const revertToGithubFeed = (cause: string): void => {
    if (!usingProxyFeed || proxyFallbackTried) return;
    proxyFallbackTried = true;
    usingProxyFeed = false;
    updater.requestHeaders = null;
    try {
      updater.setFeedURL({ provider: 'github', owner: GITHUB_OWNER, repo: GITHUB_REPO });
    } catch (err) {
      // This can run inside an async .catch(); a throw here would escape as an
      // unhandled rejection and skip the re-check. Log and bail with a
      // consistent (fallback-attempted, no re-check) state instead.
      logger.error('proxy-feed fallback setFeedURL threw', {
        cause,
        err,
      });
      return;
    }
    logger.warn('proxy feed failed — reverted to GitHub provider for this session', { cause });
    void updater.checkForUpdates().catch((err: Error & { code?: string }) => {
      // Match the module's classified/unclassified discipline: a GitHub outage
      // right after the proxy one is operationally relevant, not debug noise.
      const ctx = {
        code: err?.code,
        err,
      };
      if (isClassifiedUpdaterError(err)) {
        logger.warn('post-fallback checkForUpdates rejected', ctx);
      } else {
        logger.debug('post-fallback checkForUpdates rejected', ctx);
      }
    });
  };

  // ————————————————————————————————————————————————————————
  // Helpers over AppState — isolate persistence seam
  // ————————————————————————————————————————————————————————

  /**
   * Send an event to ONE window — used for the one-shot prompt that shouldn't
   * multiply across windows: Toast C (stuck-hint). When no window is open the
   * broadcast no-ops; the state gate still arms so the prompt doesn't re-emit
   * once a window opens. The relaunch banner (Toast A) and the release-notes
   * notice (Toast B) use `broadcastToAllWindows` instead.
   */
  const broadcast = <K extends keyof EventChannels>(
    channel: K,
    payload: EventChannels[K]['payload'],
  ): void => {
    const target = getPrimaryWindow();
    if (!target) {
      logger.debug('broadcast skipped — no primary window');
      return;
    }
    sendToRenderer(target.webContents, channel, payload);
  };

  /**
   * Send an event to EVERY open window — used for the relaunch banner (Toast A),
   * the release-notes notice (Toast B), and its cross-window dismiss. A
   * downloaded-and-waiting update and "what's new" should be visible from
   * whichever window the user is looking at, not just one. Multiplying is safe:
   * "Relaunch now" is idempotent (`ok:update:relaunch-now` clears
   * `versionPendingInstall` before `quitAndInstall()`, so a click on a second
   * window short-circuits), and the release-notes notice clears across all
   * windows on dismiss, so the same FYI isn't swatted once per window. Falls
   * back to the single primary window when `getAllWindows` is omitted (test
   * fixtures). When no window is open this no-ops; a window opened *later* picks
   * up a still-staged update or a still-live what's-new notice via the
   * main-side `browser-window-created` re-broadcast in `main/index.ts`.
   */
  const broadcastToAllWindows = <K extends keyof EventChannels>(
    channel: K,
    payload: EventChannels[K]['payload'],
  ): void => {
    const all = getAllWindows?.();
    if (!all || all.length === 0) {
      broadcast(channel, payload);
      return;
    }
    for (const win of all) {
      sendToRenderer(win.webContents, channel, payload);
    }
  };

  /**
   * Persist state, swallowing any I/O error so the caller can treat a failed
   * write as "no gate armed, will retry next event." Returns true on success,
   * false on failure — callers that must gate user-visible effects on the
   * write succeeding (Toast A / Toast C) check this before emitting.
   */
  const persistSafely = (next: AppState, ctx: string): boolean => {
    try {
      writeState(next);
      return true;
    } catch (err) {
      logger.error('writeState failed — state gate not armed', {
        ctx,
        err,
      });
      return false;
    }
  };

  /** Evaluate the stuck-hint gate on every `error` emission. */
  const maybeFireStuckHint = (): void => {
    const state = readState();
    if (state.stuckHintShown) return;
    if (!state.lastSuccessfulCheckAt) return; // no baseline yet — fresh install can't be "stuck"
    const last = Date.parse(state.lastSuccessfulCheckAt);
    if (Number.isNaN(last)) return;
    const elapsedMs = now().getTime() - last;
    if (elapsedMs < STUCK_HINT_THRESHOLD_MS) return;

    // Persist-before-emit: arm the dedupe gate first so a disk-write failure
    // cannot leave Toast C visible with no state to prevent re-emission on
    // subsequent error events. If the write fails, skip dispatch; the next
    // error event will try again.
    if (!persistSafely({ ...state, stuckHintShown: true }, 'stuck-hint')) return;

    // Defer through `whenRendererReady` for the same reason Toast A does:
    // in dev / any environment where the error fires before the
    // editor window's `did-finish-load`, a plain broadcast would skip
    // AFTER the state gate already marked `stuckHintShown = true`,
    // meaning the user never sees Toast C for this installation.
    const fireToastC = () => {
      broadcast('ok:update:stuck-hint', { downloadUrl: STUCK_HINT_DOWNLOAD_URL });
      logger.warn('stuck-hint dispatched', {
        lastSuccessfulCheckAt: state.lastSuccessfulCheckAt,
        elapsedDays: Math.floor(elapsedMs / (24 * 60 * 60 * 1000)),
      });
      onDispatch?.('stuck-hint-toast-c');
    };
    if (whenRendererReady) whenRendererReady(fireToastC);
    else fireToastC();
  };

  /**
   * Mark a successful check outcome — advances `lastSuccessfulCheckAt` and
   * resets `stuckHintShown` so the Toast C gate can re-arm if the update
   * pipeline breaks again after a repaired window.
   *
   * Routes through `persistSafely` (same discipline as every other mutation
   * site in this module). `update-available` / `update-not-available` are
   * emitted synchronously from electron-updater's promise-chain inside
   * `doCheckForUpdates()` — a thrown writeState
   * propagates out of the emitter and breaks the check pipeline before
   * `autoDownload` can trigger. Catching the throw keeps the updater event
   * loop alive even when `saveAppState` fails mid-session (EACCES, disk
   * full), logs the failure at `error` level, and lets the next event
   * retry. Skipping `onDispatch('check-success')` on failure is intentional
   * — the observability surface mirrors the state: "success was not
   * recorded."
   */
  const markCheckSucceeded = (): void => {
    const state = readState();
    if (
      !persistSafely(
        {
          ...state,
          lastSuccessfulCheckAt: now().toISOString(),
          stuckHintShown: false,
        },
        'check-success',
      )
    )
      return;
    onDispatch?.('check-success');
  };

  // ————————————————————————————————————————————————————————
  // Event subscriptions (6 total)
  // ————————————————————————————————————————————————————————

  const onCheckingForUpdate = (): void => {
    logger.info('checking-for-update');
  };

  // Menu-driven `Check for Updates…` in flight — armed by `runMenuDrivenCheck`
  // (the shared path behind BOTH the `ok:update:check-now` IPC handler AND the
  // application menu's `handle.checkForUpdatesNow()`), cleared by whichever of
  // update-available/not-available/error fires first (or by the synchronous-
  // reject catch in `runMenuDrivenCheck`). Periodic hourly checks never call
  // that path, so they leave this `false` and stay silent on a no-change
  // outcome.
  let menuCheckPending = false;

  // Armed after `quitAndInstall()` returns cleanly (packaged builds only):
  // the relaunch is "in flight" until the process exits. While armed, an
  // updater `error` event is treated as the relaunch failing (Squirrel.Mac
  // reports its failures through the event bus, not as a throw), and the
  // watchdog timer is the backstop for the silent no-quit shape. Cleared by
  // `failRelaunch` and `destroy()`; dies with the process on a healthy quit.
  let relaunchInFlight: {
    version: string;
    watchdog: ReturnType<typeof setTimeout>;
  } | null = null;

  // Armed just before `downloadUpdate()` and cleared by whichever of
  // `update-downloaded` / `error` lands. Non-null means Squirrel may be
  // mid-swap of the staging directory, which is the one state in which
  // `quitAndInstall()` must not be called: electron-updater's MacUpdater sets
  // its internal `squirrelDownloadedUpdate` flag on the FIRST successful stage
  // and never clears it, so a re-download re-points Squirrel at a fresh proxy
  // server while that flag still reads true. `quitAndInstall()` then takes the
  // "already staged, install now" branch and fires at a half-written bundle,
  // which surfaces to the user as an install that failed and worked on retry.
  // We cannot fix the upstream flag, so we refuse to call into it while a
  // stage is running.
  let stagingInFlight: { version: string } | null = null;

  // The version THIS process has actually staged, as opposed to the one
  // `versionPendingInstall` remembers from a previous run.
  //
  // The two come apart whenever a staged update does not get installed in the
  // session that fetched it — a crash, a force-quit, a failed ShipIt swap, or
  // simply any Linux session the user did not click through, since
  // install-on-quit is off there. `versionPendingInstall` deliberately survives
  // that (boot only clears it once the running version catches up), but
  // electron-updater keeps nothing: its downloaded-update helper is built
  // inside `downloadUpdate()` and dies with the process. Without the helper
  // there is no installer path and no quit handler, so both install routes are
  // dead until something calls `downloadUpdate()` again.
  //
  // So the re-download skip has to be scoped to what this process staged.
  // Skipping the first offer of a session would strand exactly the population
  // that already has a failed install behind them.
  let stagedThisSession: string | null = null;

  /**
   * The build already staged this session, when THAT is why the offer in hand
   * is being declined — otherwise null.
   *
   * Both listeners must answer this identically — `onUpdateAvailable` to decide
   * whether to fetch, `onUpdateAvailableForMenuCheck` to decide what a manual
   * check reports — or the report path advertises a download that is not
   * running. Derived once so the two cannot diverge; call it once per listener
   * rather than re-testing either arm inline. Returning the version rather than
   * a boolean is what lets the reporting path name the build without
   * re-narrowing `stagedThisSession`.
   *
   * Same version: declined on every platform. Re-downloading is not a no-op
   * even from cache, and every re-stage is a window in which a "Relaunch" click
   * hits a half-written staging directory.
   *
   * Version change: declined on macOS only, because only Squirrel.Mac holds a
   * pending install in a separate armed process that a second download races
   * rather than replaces. `onUpdateAvailable` carries the full mechanism.
   */
  const declinedForStagedVersion = (offeredVersion: string | undefined): string | null => {
    if (stagedThisSession === null) return null;
    if (stagedThisSession === offeredVersion) return stagedThisSession;
    return platform === 'darwin' ? stagedThisSession : null;
  };

  /** Accessor form, so a read after an `await` is not stale-narrowed. */
  const currentStaging = (): { version: string } | null => stagingInFlight;

  // One-shot resolvers for the click-gated freshness check. Registered before
  // the triggering call so an event that lands synchronously is never missed,
  // and drained (not filtered) on every settle so a timed-out waiter cannot
  // leak into the next click.
  let checkOutcomeWaiters: Array<(outcome: 'available' | 'settled') => void> = [];
  let stagingWaiters: Array<(ok: boolean) => void> = [];

  const settleCheckWaiters = (outcome: 'available' | 'settled'): void => {
    const waiters = checkOutcomeWaiters;
    checkOutcomeWaiters = [];
    for (const resolve of waiters) resolve(outcome);
  };

  const settleStagingWaiters = (ok: boolean): void => {
    const waiters = stagingWaiters;
    stagingWaiters = [];
    for (const resolve of waiters) resolve(ok);
  };

  // Wall-clock instant after which the "ready to install" banner may surface
  // again. Set at boot when the running version differs from the last one seen,
  // so it covers every route onto a new build (an update relaunch, an
  // install-on-quit, a hand-replaced bundle) rather than only the click path.
  // Null means no suppression is active.
  let postUpdateQuietUntil: number | null = null;

  // Pending deferred Toast A broadcast, held while the quiet window runs.
  // Cleared by `destroy()` so a teardown mid-window cannot fire into
  // destroyed windows.
  let quietWindowTimer: ReturnType<typeof setTimeout> | null = null;

  const withinPostUpdateQuietWindow = (): boolean =>
    postUpdateQuietUntil !== null && now().getTime() < postUpdateQuietUntil;

  // Set synchronously on the first accepted "Relaunch" click, cleared only by
  // `failRelaunch` (or the lost-staged-build path). The pre-existing
  // double-invoke guard relied on `versionPendingInstall` being cleared
  // synchronously before `quitAndInstall()`; the freshness check now awaits in
  // front of that persist, so a second click during the await would otherwise
  // pass the state gate and fire a non-idempotent Squirrel call twice.
  let installRequested = false;

  // Absolute path of the staged installer. Captured in-session from
  // electron-updater's `update-downloaded` payload (`downloadedFile`) and
  // persisted alongside `versionPendingInstall`, then re-seeded from state at
  // boot (after the reconciliation below) — the standard Linux flow is
  // download, quit, boot, click Relaunch, and the banner becomes clickable
  // long before the launch check re-validates the ~250 MB cache (full sha512)
  // and re-emits the path. Feeds the Linux manual-install fallback command.
  let stagedInstallerPath: string | null = null;

  /**
   * The staged installer path, filtered through the injected existence check
   * (persisted state can outlive the file — e.g. a cache cleared by hand).
   * Null when unknown or missing on disk; callers then fall through to the
   * default electron-updater path.
   */
  const usableStagedInstallerPath = (): string | null => {
    if (stagedInstallerPath === null) return null;
    const exists = linuxInstallSupport?.stagedInstallerExists;
    if (exists && !exists(stagedInstallerPath)) return null;
    return stagedInstallerPath;
  };

  /**
   * Offer the Linux manual-install fallback for `version` if the platform,
   * wiring, and staged-installer shape allow it. Returns true when the
   * dialog was dispatched (fire-and-forget — the dialog runs for as long as
   * the user keeps it open). Shared by the two triggers: the no-auth
   * preflight in `relaunch-now` and the infrastructure-classified install
   * failure in `onError`.
   */
  const offerManualInstallFallback = (version: string, kind: DispatchKind): boolean => {
    if (platform !== 'linux' || !linuxInstallSupport) return false;
    const installerPath = usableStagedInstallerPath();
    const plan = manualInstallPlanFor(installerPath);
    if (!plan || installerPath === null) return false;
    logger.warn('offering manual-install fallback', {
      version,
      packageKind: plan.packageKind,
      trigger: kind,
    });
    onDispatch?.(kind);
    void Promise.resolve(
      linuxInstallSupport.showManualInstallFallback({
        version,
        installerPath,
        ...plan,
      }),
    ).catch((err: unknown) => {
      logger.error('manual-install fallback dialog failed', { err });
    });
    return true;
  };

  /**
   * Single failure routine for all three relaunch-failure triggers — the
   * synchronous `quitAndInstall()` throw, the in-flight updater `error`
   * event, and the no-quit watchdog. Every window is on the button-less,
   * non-dismissible "Relaunching…" card by now and only the clicked window
   * has a rejection handler, so main must recover all of them: restore the
   * state gate (the update is still staged in electron-updater's cache),
   * re-broadcast `ok:update:downloaded` so each armed banner replaces the
   * stuck card in place (same notice id), and broadcast
   * `ok:update:relaunch-failed` so every window surfaces the error notice.
   * The re-arm follows persist-before-emit (skipped if the restore write
   * fails); the failure notice broadcasts unconditionally — the user must
   * learn the relaunch failed even on a failing disk.
   *
   * Not self-guarding — single-fire per attempt is the callers' contract:
   * the gate arms BEFORE `quitAndInstall()` (so even a synchronously
   * dispatched Linux install error finds it armed), `onError` gates on
   * `relaunchInFlight`, and the first failure — any trigger — clears both
   * the watchdog and the gate so no other trigger can re-enter. A new
   * failure trigger must preserve that gate.
   */
  const failRelaunch = (
    version: string,
    message: string | undefined,
    kind: DispatchKind,
    /** Original error context (error-event trigger only) — correlates this
     * recovery log line with the classified/unclassified onError entry. */
    cause?: { code?: string; stack?: string },
  ): void => {
    if (relaunchInFlight) {
      clock.clearTimeout(relaunchInFlight.watchdog);
      relaunchInFlight = null;
    }
    // The install is no longer committed, so a fresh click must be accepted —
    // the re-armed banner below is the user's retry affordance and would be
    // inert without this.
    installRequested = false;
    const restored = persistSafely(
      { ...readState(), versionPendingInstall: version },
      'relaunch-failed-restore',
    );
    if (restored) {
      broadcastToAllWindows('ok:update:downloaded', { version });
    } else if (platform !== 'darwin') {
      // The persist failed, so `versionPendingInstall` stays cleared and there
      // is no banner to retry from. Only `stagedThisSession` gates the decline,
      // so without releasing it here nothing else would: the guard would turn
      // down the re-offer of this very version on every later poll, and the
      // session would neither re-download nor re-arm the banner.
      //
      // Safe on both platforms that reach this, for different reasons. Linux
      // arms nothing at all (`autoInstallOnAppQuit` is false there), so there
      // is no pending request to double up. Windows arms only a cache entry
      // behind ONE idempotent quit handler, so a re-download replaces the
      // pending installer rather than racing it — the citation for that is at
      // the decline guard in `onUpdateAvailable`. Either way the retry banner
      // comes back for free.
      logger.warn(
        stagedThisSession === null
          ? 'relaunch-failed restore did not persist — no single-flight arm was held'
          : 'relaunch-failed restore did not persist — releasing the single-flight arm',
        { version, kind, armedVersion: stagedThisSession },
      );
      stagedThisSession = null;
    } else {
      // macOS keeps the arm: the trigger cannot tell us whether Squirrel's
      // request is still live. ShipIt is armed at
      // download-completion time (`electron-updater@6.8.4`
      // `out/MacUpdater.js#doDownloadUpdate`), not here, and each of
      // `failRelaunch`'s three triggers leaves a different possibility open:
      // the watchdog fires on an app that then quits anyway, a
      // `quitAndInstall()` throw means the app is not quitting at all, and an
      // `error` event may be Squirrel reporting a swap that already ran and
      // failed — or an unrelated error arriving while ShipIt is still pending
      // (see `onError`, which says both).
      //
      // Keeping the arm is the conservative read of all three: releasing it can
      // arm a SECOND ShipIt beside a live one, which is the bundle-losing race
      // this guard exists to prevent. The price is bounded but not zero. Usually
      // it is just the retry button, since `autoInstallOnAppQuit` installs the
      // staged build at quit regardless; but if the swap had already failed then
      // nothing installs at quit either, and this session takes no update at all
      // until the next launch.
      logger.warn(
        stagedThisSession === null
          ? 'relaunch-failed restore did not persist — no single-flight arm was held'
          : 'relaunch-failed restore did not persist — keeping the single-flight arm (darwin: ShipIt may still be waiting)',
        { version, kind, armedVersion: stagedThisSession },
      );
    }
    broadcastToAllWindows('ok:update:relaunch-failed', {
      version,
      message,
      // Every window is on the shared in-progress card by now — a relaunch
      // only fails after it was announced — and that card has no action and
      // no dismiss. A successful restore replaces it by id, so nothing more is
      // needed. A failed one leaves it there, and the error notice lands under
      // a different id at higher priority, so dismissing the error would just
      // reveal the stuck card underneath. Clear it instead.
      ...(restored ? {} : { dismissPending: true }),
    });
    logger.warn(
      restored
        ? 'relaunch failed — restored pending install and re-armed windows'
        : 'relaunch failed — pending install NOT restored',
      {
        version,
        kind,
        message,
        causeCode: cause?.code,
        causeStack: cause?.stack,
      },
    );
    onDispatch?.(kind);
  };

  // The release-notes (what's-new) notice live for this session, or null. Set
  // when Toast B fires, cleared when it's dismissed; the `firedAt` timestamp
  // gates re-delivery to late-opened windows (see `getActiveWhatsNew`).
  // In-memory only — a relaunch already advanced `lastSeenVersion`, so
  // persisting this would re-show a stale notice on the next launch.
  let activeWhatsNew: { version: string; releaseUrl: string; firedAt: number } | null = null;

  /**
   * Kick off a manual `Check for Updates…` and surface its outcome via
   * `showCheckNowResult` (production: a `dialog.showMessageBox`). Shared by the
   * application-menu entry (`handle.checkForUpdatesNow()`) and the
   * `ok:update:check-now` IPC so both gestures get the same explicit feedback —
   * a manual click that does nothing visible is a confusing UX. Arms
   * `menuCheckPending` so the next update-available / update-not-available /
   * error landing routes to the dialog; the periodic hourly check never calls
   * this and so stays silent. Returns the underlying `checkForUpdates()`
   * promise.
   */
  const runMenuDrivenCheck = (): Promise<unknown> => {
    menuCheckPending = true;
    const checkPromise = updater.checkForUpdates();
    void checkPromise.catch((err: unknown) => {
      // Log-level discipline mirrors `onError`: classified
      // `ERR_UPDATER_*` / `HTTP_ERROR_*` codes go to `warn` so operators see
      // them in production logs, everything else stays at `debug`. The
      // sync-reject path is rare today (electron-updater normally emits the
      // `error` event), but the user-visible remap helper below has to cover
      // a future electron-updater that delivers classified codes through
      // promise rejection — without matching the warn-level discipline here,
      // those rare-path classified errors would silently drop below the
      // operator's log threshold.
      const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
      const logFn = isClassifiedUpdaterError(err) ? logger.warn : logger.debug;
      logFn('check-now checkForUpdates rejected', {
        code,
        err,
        timestamp: now().toISOString(),
      });
      // The synchronous-reject path is rare (electron-updater normally emits
      // its `error` event so `onError` handles dispatch), but a hard reject
      // from the underlying provider construction WILL bypass the event bus.
      // Cover that gap here so the user still gets a dialog instead of silence.
      // `buildCheckNowResultFromError` keeps the race-window remap aligned
      // with `onError` if a future electron-updater ever routes
      // `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` through promise rejection.
      if (menuCheckPending) {
        menuCheckPending = false;
        showCheckNowResult?.(buildCheckNowResultFromError(err, getAppVersion()));
      }
    });
    return checkPromise;
  };

  /**
   * Classify an `update-available` offer against the running build's channel.
   * Returns `'same-channel'` when the offer may proceed; otherwise returns a
   * tagged veto reason so operator triage on the `cross-channel-blocked`
   * dispatch counter can distinguish the two structurally-distinct veto cases
   * (malformed electron-updater payload vs. the actual GitHub-provider
   * cascade). The dispatch kind stays single (`cross-channel-blocked`) — the
   * `reason` lives only in the warn log.
   *
   * Belt-and-braces against electron-updater's GitHub-provider cascade
   * (`beta-mac.yml`→`latest-mac.yml` on 404), which can deliver a stable
   * manifest to a beta client even when `channel='beta'` is set. We log +
   * drop the offer at our app layer regardless.
   */
  const classifyOffer = (
    offeredVersion: string | undefined,
  ): 'same-channel' | 'empty-version' | 'channel-mismatch' => {
    if (typeof offeredVersion !== 'string' || offeredVersion === '') {
      return 'empty-version';
    }
    return channelFromVersion(offeredVersion) === buildChannel
      ? 'same-channel'
      : 'channel-mismatch';
  };

  const onUpdateAvailable = (info: { version?: string }): void => {
    logger.info('update-available', { version: info.version });
    const offeredVersion = info.version;
    const offerClass = classifyOffer(offeredVersion);
    if (offerClass !== 'same-channel') {
      logger.warn('update-available vetoed', {
        reason: offerClass,
        buildChannel,
        offeredVersion: info.version,
        offeredChannel:
          offerClass === 'channel-mismatch' ? channelFromVersion(info.version ?? '') : null,
      });
      // The check pipeline itself succeeded (manifest fetched + parsed); the
      // install is gated by channel policy, not pipeline failure. Mirror
      // `onUpdateNotAvailable` and advance `lastSuccessfulCheckAt` so the
      // 7-day stuck-hint gate doesn't fire on a healthy updater serving a
      // long stable-only window to a beta cohort (or vice versa).
      markCheckSucceeded();
      settleCheckWaiters('settled');
      onDispatch?.('cross-channel-blocked');
      return;
    }
    markCheckSucceeded();
    // Already staged, and staged bundles are not re-fetched. electron-updater
    // emits `update-available` on every check for as long as the remote build
    // is newer than the RUNNING one, so a pending update re-offers itself on
    // each poll. Re-downloading it is not a no-op even when the file is
    // already in the cache: the cached path still runs the post-download
    // handoff, which tears down the Squirrel proxy server and re-stages the
    // identical bytes. Every one of those re-stages is a window in which a
    // "Relaunch" click hits a half-written staging directory (see
    // `stagingInFlight`), so an hourly re-stage of a build we already hold is
    // pure downside.
    //
    // On macOS a version CHANGE is declined too, for a different and harder
    // reason: Squirrel holds a pending install by LAUNCHING ShipIt, which then
    // waits — with no timeout of its own — for this process to exit.
    // Downloading again does not replace that request, it launches a SECOND
    // ShipIt beside the first, and both wake in the same instant when the app
    // finally quits. They then race the same swap: the loser moves aside the
    // bundle the winner just installed, and if it cannot move it back the app
    // is gone from /Applications with nothing left to launch. Nothing in
    // Electron's autoUpdater API can withdraw an armed request, so declining
    // the second download is the only lever available. The staged build still
    // installs at quit and the newer one is picked up in the session after. The
    // cost is not a one-version bound: on macOS nothing clears
    // `stagedThisSession`, so every further offer this process sees is declined
    // too, and a session long enough to span several releases installs the first
    // build it staged and stays there until the next launch. (Off macOS
    // `failRelaunch` releases it when it cannot restore the retry banner; see
    // there for why that release stops at the macOS boundary.)
    //
    // Nowhere else has a request to collide with, so nowhere else pays that
    // cost. On Windows a download only writes an installer to the cache and
    // `BaseUpdater.addQuitHandler` is idempotent — it guards on
    // `quitHandlerAdded`, and the handler it registers calls `install()`, which
    // reads the most recent download — so the single quit handler runs
    // whichever installer was downloaded LAST: a newer build replaces the
    // pending one rather than racing it. On Linux `autoInstallOnAppQuit` is
    // false (see its assignment), so `addQuitHandler` returns early and no quit
    // handler is registered at all, leaving nothing pending between the
    // download and an explicit relaunch click. Cited rather than asserted
    // because this reading is what removes the guard on those platforms:
    // `electron-updater@6.8.4` (exact-pinned in `packages/desktop/package.json`)
    // `out/BaseUpdater.js#addQuitHandler` and `out/NsisUpdater.js#doDownloadUpdate`.
    // The tests cannot catch a mistake here — they run against a stub of
    // electron-updater, so they pin our gating, not its behaviour.
    //
    // `stagedThisSession` — not the persisted field — is what makes both skips
    // safe (see its declaration): the persisted field alone would also match on
    // the FIRST offer of a session that inherited a staged-but-uninstalled
    // build, and skipping there leaves electron-updater with no installer path
    // and no quit handler, so the update becomes uninstallable until a newer
    // one ships. Keying on a COMPLETED stage likewise leaves a download that
    // failed free to retry: nothing reached Squirrel, so there is no pending
    // request to collide with.
    const armedVersion = declinedForStagedVersion(offeredVersion);
    if (armedVersion !== null) {
      // `debug` for the hourly re-offer of bytes already held; `warn` for a
      // suppressed newer build, because production's log floor is `info`, so a
      // `debug` line never reaches `~/.ok/logs` and therefore never reaches a
      // bug report. That decision suppresses a genuinely newer build for the
      // rest of the process lifetime, which is exactly the question a "why am I
      // not getting the update" report has to be able to answer.
      const reOffer = armedVersion === offeredVersion;
      const logFn = reOffer ? logger.debug : logger.warn;
      logFn(
        reOffer
          ? 'update-available for the already-staged version — skipping re-download'
          : 'update-available while an install is already armed — skipping re-download',
        { version: offeredVersion, armedVersion },
      );
      settleCheckWaiters('settled');
      onDispatch?.(reOffer ? 'download-skipped-already-staged' : 'download-skipped-install-armed');
      return;
    }
    // Tag the artifact fetch with the version being installed. The Windows and
    // Linux installers carry version-less names and stable resolves them
    // through GitHub's `latest` alias, so the proxy has nothing to parse and
    // those updates would otherwise land in analytics with no `to_version` at
    // all — only the macOS zip embeds its version. electron-updater reads
    // `requestHeaders` when `downloadUpdate()` runs, not when the feed is
    // configured, so setting it here reaches the artifact request; it is safe
    // to do only because `autoDownload = false` puts that call below us rather
    // than in a race with this handler. Guarded on the proxy feed so the
    // GitHub fallback (which nulls these headers) never grows a custom one.
    if (usingProxyFeed && offeredVersion) {
      updater.requestHeaders = {
        ...updater.requestHeaders,
        'x-ok-to-version': offeredVersion,
      };
    }
    // `autoDownload = false`, so we kick off the download explicitly only
    // after the channel-match check passes. Defensive catch: rejections also
    // surface through the `error` event handler, but a synchronous reject
    // before the event bus engages (rare: provider-construction failure
    // mid-flight) would only show up in this log line. Match
    // `runMenuDrivenCheck`'s classified/unclassified discipline so
    // classified codes land at `warn` with code + stack + timestamp.
    // Arm BEFORE the call: `downloadUpdate()` can reject synchronously, and a
    // gate armed after the fact would leave a rejection with nothing to clear.
    stagingInFlight = { version: offeredVersion ?? 'unknown' };
    settleCheckWaiters('available');
    void updater.downloadUpdate().catch((err: unknown) => {
      const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
      const logFn = isClassifiedUpdaterError(err) ? logger.warn : logger.debug;
      logFn('downloadUpdate rejected', {
        code,
        err,
        timestamp: now().toISOString(),
      });
      // Rejections also reach `onError`, which clears the gate — but a
      // provider-construction failure rejects without ever engaging the event
      // bus, and a gate left armed there would block every later relaunch.
      if (stagingInFlight) {
        stagingInFlight = null;
        settleStagingWaiters(false);
      }
    });
  };

  // The menu-check feedback path — separate listener so the existing
  // event-registration shape is preserved. Registered alongside
  // `onUpdateAvailable`; both fire for every `update-available` event.
  const onUpdateAvailableForMenuCheck = (info: { version?: string }): void => {
    if (!menuCheckPending) return;
    menuCheckPending = false;
    // Cross-channel offer surfaced through a manual "Check for Updates…":
    // route to the friendly "up to date" dialog instead of advertising an
    // update we won't install. Mirrors the `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`
    // remap in `onError`.
    if (classifyOffer(info.version) !== 'same-channel') {
      showCheckNowResult?.({ kind: 'not-available', currentVersion: getAppVersion() });
      return;
    }
    // This listener fires for the same event as `onUpdateAvailable` and cannot
    // see that it declined the offer, so it has to ask the same question that
    // path asked, or it will advertise a download that is not happening. Report
    // the build the session is actually holding: an offer declined by the
    // single-flight guard is not what a relaunch installs, and saying otherwise
    // sends the user round the same check forever waiting for a version that
    // never arrives. The declined-because-already-staged case reaches here too
    // — nothing is downloading there either.
    const armedVersion = declinedForStagedVersion(info.version);
    if (armedVersion !== null) {
      showCheckNowResult?.({
        kind: 'ready-to-install',
        currentVersion: getAppVersion(),
        stagedVersion: armedVersion,
      });
      return;
    }
    showCheckNowResult?.({
      kind: 'available',
      currentVersion: getAppVersion(),
      latestVersion: typeof info.version === 'string' ? info.version : 'unknown',
    });
  };

  const onUpdateNotAvailable = (info: { version?: string }): void => {
    logger.info('update-not-available', { version: info.version });
    markCheckSucceeded();
    settleCheckWaiters('settled');
    if (menuCheckPending) {
      menuCheckPending = false;
      showCheckNowResult?.({
        kind: 'not-available',
        currentVersion: getAppVersion(),
      });
    }
  };

  const onDownloadProgress = (info: { percent?: number; bytesPerSecond?: number }): void => {
    // Debug-level; no UI surface for progress (no progress toast).
    // Log stays for operator diagnosis only.
    logger.debug('download-progress', {
      percent: info.percent,
      bytesPerSecond: info.bytesPerSecond,
    });
  };

  const onUpdateDownloaded = (info: { version?: string; downloadedFile?: string }): void => {
    logger.info('update-downloaded', { version: info.version });
    // Release the relaunch gate first, ahead of every early return below: the
    // stage is finished whether or not this event goes on to dispatch a
    // banner, and a gate left armed on a deduped or empty-version event would
    // block relaunches for the rest of the session.
    stagingInFlight = null;
    settleStagingWaiters(true);
    // Track the staged file even when the dispatch below dedupes or skips —
    // the file exists on disk regardless, and the Linux fallback needs it.
    if (typeof info.downloadedFile === 'string' && info.downloadedFile !== '') {
      stagedInstallerPath = info.downloadedFile;
    }
    const version = typeof info.version === 'string' ? info.version : '';
    if (!version) {
      logger.warn('update-downloaded with empty version — skipping dispatch');
      onDispatch?.('update-downloaded-empty-version');
      return;
    }
    // Record before the dedupe below: this is the point electron-updater holds
    // a real staged artifact for this process, which is what the re-download
    // skip keys on. A deduped re-fire is still a stage.
    stagedThisSession = version;
    const state = readState();
    if (state.versionPendingInstall === version) {
      logger.info('update-downloaded re-fired for same pending version — deduped', { version });
      onDispatch?.('update-downloaded-deduped');
      return;
    }
    // Persist-before-emit: arm the versionPendingInstall gate BEFORE Toast A
    // so an atomic-write failure (disk full, EACCES, etc.) cannot produce a
    // user-visible toast with no state to prevent re-emission on the next
    // update-downloaded event. If persist fails, skip dispatch — electron-
    // updater will re-fire from its on-disk cache and we get another shot.
    // Arm BOTH the banner gate (`versionPendingInstall`) and — where a plain
    // quit commits the install — the boot-time failure-detection record
    // (`attemptedInstall`). With `autoInstallOnAppQuit` the staged update is
    // committed to install on the next quit (whether via "Relaunch now" or a
    // plain quit), so download time IS the point the install is "attempted".
    // `attemptedInstall` survives the `relaunch-now` clear of
    // `versionPendingInstall`, letting the next boot tell success from a
    // silently-failed install.
    //
    // NOT on Linux: install-on-quit is off there (see the
    // `autoInstallOnAppQuit` assignment), so a user who downloads and then
    // simply quits never committed to an install — arming here would make
    // the next boot surface a false "Update didn't install" notice (up to
    // the surfacing cap) for that most-common path. Linux arms the record at
    // its actual commit point, the `relaunch-now` handler.
    const installCommittedAtDownload = platform !== 'linux';
    if (
      !persistSafely(
        {
          ...state,
          versionPendingInstall: version,
          // Persist the staged path with the banner gate so the Linux
          // fallback can build its command on the next boot, before the
          // launch check re-validates the cache (see the AppState field doc).
          stagedInstallerPath,
          // Staged-at for the pending version. This is the only moment the
          // staging clock can start: `update-downloaded` is when Squirrel has
          // the bundle and the install becomes requestable.
          versionPendingInstallStagedAt: now().getTime(),
          // The age is measured from the staged-at above, so the two move
          // together: arming restarts the staging clock, which leaves any age
          // recorded against the previous staging meaningless. Left set, it
          // would be reported at the NEXT boot-detected failure as if it
          // described that install — a stale number reads as real signal and
          // is worse than the age being absent. Unlike
          // `attemptedInstallSurfacedCount`, which is scoped to the version
          // and so survives a same-version re-arm, this is scoped to the
          // staging and resets with it.
          attemptedInstallStagingAgeMs: null,
          // Reset with the staging for the same reason: a handoff recorded
          // against the PREVIOUS artifact would otherwise be read as this
          // attempt's, and a stale instant hours in the past condemns an
          // install that was just committed.
          attemptedInstallHandoffAt: null,
          ...(installCommittedAtDownload
            ? {
                attemptedInstall: version,
                // Fresh failure budget for a newly-attempted version; preserved
                // when the same version re-arms (e.g. a re-download after
                // `relaunch-now` cleared `versionPendingInstall`) so the
                // boot-nag cap isn't reset.
                attemptedInstallSurfacedCount:
                  state.attemptedInstall === version ? state.attemptedInstallSurfacedCount : 0,
                // Same version scoping, and load-bearing here rather than
                // merely tidy: this re-arm is what clears the handoff stamp, so
                // a count that reset alongside it would leave the deferral with
                // nothing that outlives a re-arm — and an install that never
                // lands could be held quiet forever.
                attemptedInstallDeferredBoots:
                  state.attemptedInstall === version ? state.attemptedInstallDeferredBoots : 0,
              }
            : {}),
        },
        'update-downloaded',
      )
    )
      return;
    // Fan out to EVERY open window — a downloaded-and-waiting update should be
    // actionable from whichever window the user is looking at, not just one
    // (the "Relaunch now" button is idempotent across windows; see
    // `broadcastToAllWindows`). Deferred through `whenRendererReady` so it
    // lands AFTER the primary window's renderer has attached its
    // `ok:update:downloaded` subscriber: in dev + smoke the mock
    // download completes in ~300ms — before Electron's `did-finish-load` —
    // so a synchronous send would be dropped AFTER the state gate already
    // armed, losing Toast A for the rest of the session. `whenRendererReady`
    // handles the three timing cases (loaded / loading / no window yet — see
    // main/index.ts); it gates on the *primary* window, and the other windows
    // are virtually always already loaded by the time a real download
    // (minutes) completes.
    const fireToastA = () => {
      broadcastToAllWindows('ok:update:downloaded', { version });
      logger.info('update-downloaded dispatched Toast A (all windows)', { version });
      onDispatch?.('update-downloaded-toast-a');
    };
    // Hold the banner while the post-update quiet window runs. The state gate
    // above is already armed, so the update is fully staged and still installs
    // at the next quit — the only thing deferred is the interruption. Deferring
    // rather than dropping matters because the dedupe gate above would never
    // let this version dispatch again: a dropped banner would be gone for the
    // rest of the session, and a user who keeps the app open past the window
    // would never learn the update was waiting.
    if (withinPostUpdateQuietWindow()) {
      const remainingMs = (postUpdateQuietUntil ?? 0) - now().getTime();
      logger.info('update-downloaded within post-update quiet window — deferring Toast A', {
        version,
        remainingMs,
      });
      onDispatch?.('toast-a-deferred-post-update-quiet');
      if (quietWindowTimer) clock.clearTimeout(quietWindowTimer);
      quietWindowTimer = clock.setTimeout(
        () => {
          quietWindowTimer = null;
          // The window has elapsed, so a late-opened window may surface the
          // banner too — clearing here keeps `withinPostUpdateQuietWindow` and
          // the deferred fire from disagreeing.
          postUpdateQuietUntil = null;
          onDispatch?.('toast-a-quiet-window-elapsed');
          if (whenRendererReady) whenRendererReady(fireToastA);
          else fireToastA();
        },
        Math.max(0, remainingMs),
      );
      return;
    }
    if (whenRendererReady) whenRendererReady(fireToastA);
    else fireToastA();
  };

  const onError = (err: Error & { code?: string }): void => {
    if (isClassifiedUpdaterError(err)) {
      logger.warn('error (classified)', {
        code: err.code,
        err,
        timestamp: now().toISOString(),
      });
      onDispatch?.('error-classified');
    } else {
      logger.error('error (unclassified)', {
        err,
        timestamp: now().toISOString(),
      });
      onDispatch?.('error-unclassified');
    }
    // Any updater error ends whatever check or stage was running. Release both
    // gates before the routing below, which can quit the app: a waiter left
    // unresolved would hold a "Relaunch" click until its timeout for no reason,
    // and a `stagingInFlight` left armed would block every later one.
    settleCheckWaiters('settled');
    if (stagingInFlight) {
      stagingInFlight = null;
      settleStagingWaiters(false);
    }
    // electron-updater surfaces feed/manifest failures primarily through this
    // event, not as a checkForUpdates() rejection. If the proxy feed is the
    // active source, treat any updater error as the proxy failing and revert to
    // the GitHub provider for the rest of the session — the idempotency guard
    // makes this a no-op once the fallback has run or when the proxy is off, so
    // it never disturbs the GitHub-direct path.
    revertToGithubFeed(err.code ?? err.message);
    // Async relaunch-failure fast path: Squirrel.Mac reports install/swap
    // failures through this event bus AFTER `quitAndInstall()` returned
    // cleanly — never as a throw. While a relaunch is in flight, treat any
    // updater error as that relaunch failing and recover every window now
    // rather than waiting out the no-quit watchdog. An unrelated error
    // (a periodic check, or a menu "Check for Updates…" clicked during the
    // in-flight window) is possible and would surface a misleading
    // "Relaunch failed" while ShipIt might still complete — but we
    // deliberately do NOT gate on `!menuCheckPending`: skipping recovery
    // when the error IS the relaunch failing strands every window on the
    // dead-end card, strictly worse than a confusing-but-recoverable
    // notice. Dispatch is intentionally additive: the generic
    // classified/unclassified dispatch above still fires (the error is
    // independently an updater error in the operator log);
    // 'relaunch-error-event' reports the recovery, not a replacement.
    if (relaunchInFlight) {
      const failedVersion = relaunchInFlight.version;
      // On Linux, tell an explicit user cancellation of the auth prompt
      // (pkexec exit 126) apart from authorization infrastructure that
      // cannot work (no agent, sudo-without-tty, …). Cancellation keeps the
      // existing recovery only — the user knows what they clicked; the
      // banner re-arms for another try. Infrastructure failures additionally
      // offer the manual-install fallback after the recovery lands.
      const failureClass = platform === 'linux' ? classifyInstallFailure(err.message) : null;
      failRelaunch(
        failedVersion,
        failureClass === 'cancelled'
          ? 'authorization was cancelled'
          : err.message || 'update error during relaunch',
        'relaunch-error-event',
        { code: err.code, stack: err.stack },
      );
      if (failureClass === 'infrastructure') {
        offerManualInstallFallback(failedVersion, 'linux-manual-fallback-after-error');
      }
    }
    if (menuCheckPending) {
      menuCheckPending = false;
      // `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` surfaces from electron-updater's
      // cascade-fallback behavior (GitHubProvider.getLatestVersion catch
      // site): when fetching `<channel>-mac.yml` fails, it retries with
      // `latest-mac.yml`, so the user-visible URL names `latest-mac.yml`
      // even on the beta channel.
      //
      // The original steady-state race — `release.yml` creating the
      // GitHub Release before `desktop-release.yml` uploaded the
      // channel manifest — is closed by the --draft + promote-after-
      // upload flow in those workflows. This handler is now defense-
      // in-depth for the residual triggers that can still fire it:
      //   - ~60s .atom-feed propagation delay after draft→published flip
      //   - Real-world transient errors (5xx, network, asset-CDN latency)
      //   - Manual rollbacks or out-of-band release edits
      //   - Future workflow regressions
      //
      // Route the menu-driven check to the friendly "up to date" dialog
      // so the user doesn't see an alarming 404 for a transient state.
      // The next periodic check picks up the manifest once it lands.
      // The classified-warn log above still captures the code + URL for
      // operator triage. `buildCheckNowResultFromError` keeps this remap
      // aligned with the synchronous-reject path in `runMenuDrivenCheck`.
      showCheckNowResult?.(buildCheckNowResultFromError(err, getAppVersion()));
    }
    maybeFireStuckHint();
  };

  updater.on('checking-for-update', onCheckingForUpdate);
  updater.on('update-available', onUpdateAvailable);
  updater.on('update-available', onUpdateAvailableForMenuCheck);
  updater.on('update-not-available', onUpdateNotAvailable);
  updater.on('download-progress', onDownloadProgress);
  updater.on('update-downloaded', onUpdateDownloaded);
  updater.on('error', onError);

  // ————————————————————————————————————————————————————————
  // Click-gated freshness check
  // ————————————————————————————————————————————————————————

  /**
   * Resolve on the first of any number of signals, with a timeout backstop.
   *
   * `register` receives a `finish` callback it may wire to as many sources as
   * it likes; the first call wins and every later one is ignored. Deliberately
   * not a `Promise.race` over separately-timed promises: the timer lives here
   * and is cleared on whichever path settles, so a wait that ends early cannot
   * strand a timer that later fires into a torn-down updater.
   */
  const firstOf = <T>(
    register: (finish: (value: T) => void) => void,
    timeoutMs: number,
    onTimeout: T,
  ): Promise<T> =>
    new Promise<T>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: T): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clock.clearTimeout(timer);
        resolve(value);
      };
      timer = clock.setTimeout(() => finish(onTimeout), timeoutMs);
      register(finish);
    });

  /**
   * Bring the staged build up to date before installing it, and never hand
   * `quitAndInstall()` a staging directory that is still being written.
   *
   * Two things make this necessary at click time rather than on the periodic
   * cadence. The release cadence outruns the check interval, so the staged
   * build is routinely superseded before the user acts on it — the click is
   * the first moment we know an install is actually wanted, and the last
   * moment we can still change which version it lands on. And a stage that is
   * in flight when the click arrives is exactly the state that breaks the
   * install, so the wait is a correctness requirement, not just a freshness
   * nicety.
   *
   * Deliberately gated on the click and not on hover: a hover precedes a click
   * by a few hundred milliseconds, which is nowhere near enough to fetch an
   * update, so hover could only ever discover staleness, never resolve it.
   *
   * Never throws. Every failure and timeout falls through to installing
   * whatever is currently staged, because a stale install still beats a
   * refusal to relaunch.
   *
   * On macOS it can no longer resolve staleness once THIS session has staged a
   * build: the single-flight guard in `onUpdateAvailable` declines the newer
   * offer this check turns up, so the refresh confirms which version installs
   * rather than changing it. That is the intended trade — a second armed ShipIt
   * would be woken seconds later by this very click, which is the worst
   * instance of the race the guard exists to prevent. The freshness resolution
   * described above still applies on Windows and Linux, and on a macOS session
   * that has not staged anything yet.
   */
  const refreshBeforeInstall = async (): Promise<void> => {
    // A stage already running is the dangerous case, and it is also the case
    // where a fresh check would tell us nothing new. Wait it out.
    if (stagingInFlight) {
      logger.info('relaunch-now waiting on in-flight staging before install', {
        version: stagingInFlight.version,
      });
      onDispatch?.('relaunch-awaited-in-flight-staging');
      await firstOf<boolean>(
        (finish) => stagingWaiters.push(finish),
        RELAUNCH_REFRESH_DOWNLOAD_MS,
        false,
      );
      return;
    }
    const result = await firstOf<'available' | 'settled' | 'timeout'>(
      (finish) => {
        // Register the event waiter BEFORE the check so an `update-available`
        // emitted synchronously from inside it still lands here.
        checkOutcomeWaiters.push(finish);
        // The check promise settling is a terminal signal in its own right,
        // and wiring it alongside the event closes a hole: electron-updater
        // emits its outcome event from inside the check and only then
        // resolves, so a promise that resolves with no event means a path
        // that reported nothing (a disabled updater short-circuits without
        // emitting). Waiting on the event alone would stall such a click for
        // the full timeout. The event still wins whenever it fires, because
        // it fires first.
        void updater.checkForUpdates().then(
          () => finish('settled'),
          (err: unknown) => {
            // Rejections reach `onError`, which settles the waiter too.
            logger.debug('relaunch-now refresh checkForUpdates rejected', { err });
            finish('settled');
          },
        );
      },
      RELAUNCH_REFRESH_CHECK_MS,
      'timeout',
    );
    if (result === 'timeout') {
      logger.info('relaunch-now refresh check timed out — installing the staged build');
      onDispatch?.('relaunch-refresh-timed-out');
      return;
    }
    // Read through the accessor: the early return above narrowed
    // `stagingInFlight` to null for the rest of this body, and the handler
    // that re-arms it ran during the await, which control-flow analysis does
    // not model.
    const staging = currentStaging();
    if (result !== 'available' || !staging) {
      // Either nothing newer exists, or the offer was vetoed, already staged,
      // or declined by the single-flight guard. All of them mean the staged
      // build is the one to install, which is what this kind reports — it says
      // the refresh did not change the outcome, not that nothing newer exists.
      // The cases stay separable downstream because each declining path emits
      // its own kind in the same click: `download-skipped-install-armed` for
      // the macOS single-flight, `download-skipped-already-staged` for a
      // re-offer of the staged build, `cross-channel-blocked` for a veto. A
      // lone `relaunch-refresh-up-to-date` is the genuinely-up-to-date case.
      onDispatch?.('relaunch-refresh-up-to-date');
      return;
    }
    logger.info('relaunch-now found a newer build — fetching it before installing', {
      version: staging.version,
    });
    onDispatch?.('relaunch-refresh-found-newer');
    await firstOf<boolean>(
      (finish) => stagingWaiters.push(finish),
      RELAUNCH_REFRESH_DOWNLOAD_MS,
      false,
    );
  };

  // ————————————————————————————————————————————————————————
  // IPC handler — Toast A's "Relaunch now"
  // ————————————————————————————————————————————————————————

  const register = createHandler(ipcMain as IpcMain);
  register('ok:update:relaunch-now', async (_event: IpcMainInvokeEvent): Promise<undefined> => {
    // Gate on versionPendingInstall — the only legitimate caller is Toast A's
    // "Relaunch now" button, which the renderer only shows after the main-side
    // `onUpdateDownloaded` gate armed the state. Invoking `quitAndInstall()`
    // with nothing staged is undefined behavior in Squirrel.Mac (best case:
    // app quits and relaunches same version; worst case: inconsistent state).
    // Ignore + log any invocation that reaches main without state backing it.
    //
    // Single `readState()` snapshot feeds both the gate check AND the
    // persist spread — Electron's main process is single-threaded so no
    // TOCTOU risk exists, and the dedup is cleaner than two reads with
    // identical results.
    if (installRequested) {
      logger.warn('relaunch-now invoked while an install is already committed — ignoring');
      onDispatch?.('relaunch-double-invoke-blocked');
      return undefined;
    }
    const preRefresh = readState();
    if (!preRefresh.versionPendingInstall) {
      logger.warn('relaunch-now invoked without versionPendingInstall — ignoring');
      return undefined;
    }
    installRequested = true;
    // Tell every window we are working before the await: the freshness check
    // can take seconds, and a newer build found by it can take minutes more.
    // Without this the clicked window sits on its local in-progress swap while
    // the others keep showing a stale, clickable banner.
    broadcastToAllWindows('ok:update:fetching-latest', {
      version: preRefresh.versionPendingInstall,
    });
    await refreshBeforeInstall();
    // Re-read: the refresh may have staged a newer version, which rewrites
    // `versionPendingInstall`. Installing `preRefresh`'s value here would name
    // the superseded build in the persist and in every log line downstream.
    const snapshot = readState();
    if (!snapshot.versionPendingInstall) {
      // The refresh cleared the gate rather than advancing it, which means the
      // staged build stopped being installable while we waited. Recover the
      // windows instead of calling into Squirrel with nothing staged.
      //
      // Deliberately NOT also gated on `stagedThisSession`. A click on a build
      // this process never staged is the case the refresh above exists to
      // resolve, and it normally does by downloading it. When it cannot (an
      // offline check), electron-updater reports the missing installer path
      // through its error event, which `failRelaunch` already turns into a
      // re-armed banner plus an explained failure — the same recovery this
      // branch performs, reached one step later.
      logger.warn('relaunch-now lost its staged build during the freshness check — ignoring');
      installRequested = false;
      broadcastToAllWindows('ok:update:relaunch-failed', {
        version: preRefresh.versionPendingInstall,
        message: 'the update stopped being available',
        // Nothing is staged, so there is no banner to re-arm — but every
        // window is still showing the fetching card this click painted, and
        // that card has no action and no dismiss. Clear it explicitly, or the
        // error notice merely stacks on top of a permanent one.
        dismissPending: true,
      });
      return undefined;
    }
    const pending = snapshot.versionPendingInstall;
    // Linux preflight: with no graphical auth wrapper on PATH,
    // `quitAndInstall()` would route through terminal `sudo` — no usable
    // prompt in a GUI session, guaranteed failure. Skip the attempt
    // entirely: leave `versionPendingInstall` armed (the staged update must
    // survive dismissal, a premature relaunch, and the next boot), restore
    // the clicked window's banner (it swapped to "Relaunching…" locally on
    // click; the re-broadcast is a same-id in-place replace), and hand the
    // user the manual-install dialog instead. Only when the staged installer
    // is a recognized package — otherwise fall through and let
    // electron-updater report whatever it can.
    if (
      platform === 'linux' &&
      linuxInstallSupport &&
      manualInstallPlanFor(usableStagedInstallerPath()) !== null &&
      !linuxInstallSupport.hasGraphicalAuth()
    ) {
      // Nothing was committed, and the banner is being re-armed right above —
      // release the commit flag so that re-armed banner is clickable again.
      installRequested = false;
      broadcastToAllWindows('ok:update:downloaded', { version: pending });
      offerManualInstallFallback(pending, 'linux-manual-fallback-no-auth');
      return undefined;
    }
    // Double-invoke guard: clear the state gate
    // BEFORE calling `quitAndInstall()` so a second IPC fire (rapid
    // double-click on Toast A's "Relaunch now" — sonner doesn't debounce
    // the action button) sees `pending === null` and short-circuits.
    // `autoUpdater.quitAndInstall()` is not documented as idempotent on
    // Squirrel.Mac; observed outcomes range from no-op to "update staging
    // is interrupted and the app relaunches at the old version" (the
    // failure mode this guard is specifically designed to prevent). If the
    // persist fails, skip the call entirely — better to leave the toast
    // visible and let the user click again (with a healthy disk) than to
    // fire a non-idempotent operation on unreliable state.
    //
    // On Linux this persist ALSO arms the boot-time failure-detection record:
    // the click on "Relaunch now" is Linux's actual install-commit point
    // (install-on-quit is off there, so `onUpdateDownloaded` deliberately did
    // not arm it — see that handler). Same fresh-budget semantics as the
    // download-time arming on the other platforms.

    // How long the update had been staged when the user asked for it. Recorded
    // here because this is the last moment a live process knows it: the install
    // happens after the quit, and the boot that detects a failure runs in a
    // different process. `versionPendingInstallStagedAt` deliberately survives
    // this persist — a Retry after a failed install measures from the original
    // staging, which is what "how long has this been staged" means.
    // A non-positive delta means the wall clock moved backwards between staging
    // and the click (an NTP correction, a VM resume), not an instant install —
    // report it as unknown, matching the read-side coercion in `parseAppState`.
    const stagedAt = snapshot.versionPendingInstallStagedAt;
    const rawStagingAge = stagedAt === null ? null : now().getTime() - stagedAt;
    const stagingAgeMs = rawStagingAge !== null && rawStagingAge > 0 ? rawStagingAge : null;
    if (
      !persistSafely(
        {
          ...snapshot,
          versionPendingInstall: null,
          attemptedInstallStagingAgeMs: stagingAgeMs,
          // The click IS the handoff. Re-stamped on every click, unlike the
          // quit path: a Retry is an explicit request for a fresh install
          // attempt, and the surfacing budget already bounds how many of those
          // a persistently-failing install can hide behind.
          attemptedInstallHandoffAt: now().getTime(),
          ...(platform === 'linux'
            ? {
                attemptedInstall: pending,
                attemptedInstallSurfacedCount:
                  snapshot.attemptedInstall === pending
                    ? snapshot.attemptedInstallSurfacedCount
                    : 0,
                attemptedInstallDeferredBoots:
                  snapshot.attemptedInstall === pending
                    ? snapshot.attemptedInstallDeferredBoots
                    : 0,
              }
            : {}),
        },
        'relaunch-now',
      )
    ) {
      // The whole point of bailing here is that the user can click again once
      // the disk is healthy, so the commit flag has to come back off with it —
      // and so does the banner. Every window is currently showing the fetching
      // card, which has no action and no dismiss, so releasing the flag alone
      // would leave the click with nothing to click.
      //
      // The broadcast covers the other windows; the throw covers the clicked
      // one, and it has to be a throw rather than a quiet return. Resolving
      // would run that window's success continuation, which dismisses the
      // shared notice id and so removes the banner this broadcast just put
      // back — and whether it wins is a race, because the broadcast and the
      // invoke reply travel different IPC pipes and are ordered only within a
      // pipe. Rejecting instead routes the clicked window to its failure arm,
      // which re-arms the banner itself and tells the user the click did not
      // take. Same reasoning as the `quitAndInstall` throw below.
      installRequested = false;
      broadcastToAllWindows('ok:update:downloaded', { version: pending });
      // Pair the re-arm with the reason, the way `failRelaunch` does for the
      // watchdog and throw paths. Without it the other windows watch the
      // banner reappear with no account of why, and the clicked window is the
      // only one that learns a relaunch was even attempted. Same version-keyed
      // id as the rejection notice below, so the clicked window dedupes.
      broadcastToAllWindows('ok:update:relaunch-failed', {
        version: pending,
        message: 'could not save the update state',
      });
      throw new Error('could not save the update state');
    }
    // Tell EVERY window the relaunch is underway BEFORE the teardown await:
    // each renderer swaps its "…ready to install [Relaunch]" banner to the
    // button-less "Relaunching…" in-progress card. The clicked window already
    // swapped locally for instant feedback; this fans the same state to the
    // others so they don't keep showing a stale, clickable banner during the
    // up-to-10s `prepareForRelaunch` server teardown (and can't fire a
    // redundant relaunch). Gated by the `versionPendingInstall` check above, so
    // it only fires when main is committed to `quitAndInstall()`. Idempotent on
    // the renderer (same-id in-place card swap), like the what's-new dismiss
    // fan-out.
    broadcastToAllWindows('ok:update:relaunching', { version: pending });
    onDispatch?.('relaunching-broadcast');
    // Fire the pre-relaunch teardown hook BEFORE `quitAndInstall()`. Wrap
    // in try/catch so a hook bug never blocks the user's relaunch. The worst
    // case if the hook throws is that the teardown it owns does not run:
    // servers are not stopped and the async log buffer is not drained, so
    // helper processes can outlive the swap and the tail of the log is lost.
    // Not a blocked install — ShipIt's "App Still Running" abort keys on
    // another process claiming THIS bundle URL, and a spawned server claims its
    // own helper bundle, so it cannot trigger that (see `window-manager.ts`,
    // which states the same constraint). We log the throw so the diagnostic is
    // visible in main process stderr.
    if (opts.prepareForRelaunch) {
      try {
        await opts.prepareForRelaunch();
      } catch (err) {
        logger.warn('prepareForRelaunch threw — proceeding to quitAndInstall anyway', {
          err,
        });
      }
    }
    logger.info('relaunch-now invoked — calling autoUpdater.quitAndInstall', {
      pending,
      stagingAgeMs,
    });
    onDispatch?.('relaunch-now');
    // Arm the in-flight gate BEFORE the call, not after it returns. On
    // Squirrel.Mac failures surface asynchronously (the `error` event, or a
    // silent no-quit the watchdog backstops), but the Linux installers run a
    // BLOCKING pkexec install inside quitAndInstall and dispatch their
    // failure through the `error` event BEFORE it returns — armed-after
    // would leave onError's in-flight path unreachable there, and a
    // cancelled password prompt would surface 15s later as a misleading
    // "the update timed out" instead of the real cause. Packaged builds
    // only — in dev, quitAndInstall is a DOCUMENTED silent no-op (MacUpdater
    // can't replace an unpackaged .app), not a failure.
    if (isPackaged) {
      const watchdog = clock.setTimeout(() => {
        // User-facing detail (rendered after "Relaunch failed — please
        // restart manually:"), so name the outcome, not the internal step.
        failRelaunch(pending, 'the update timed out', 'relaunch-watchdog-fired');
      }, RELAUNCH_WATCHDOG_MS);
      relaunchInFlight = { version: pending, watchdog };
    }
    try {
      updater.quitAndInstall();
    } catch (err) {
      // quitAndInstall threw — the app is NOT quitting. `failRelaunch`
      // clears the just-armed gate + watchdog and recovers every window
      // (restore gate + re-arm + failure notice); rethrow so the clicked
      // window's invoke also rejects and its rejection-path notice lands
      // (idempotent with the broadcast — same version-keyed id).
      failRelaunch(
        pending,
        err instanceof Error ? err.message : String(err),
        'relaunch-failed-rearm',
      );
      throw err;
    }
    return undefined;
  });

  // Renderer-invoked out-of-cadence update check (e.g. a Settings-pane
  // "Check for updates" button). Same surface as the application-menu entry,
  // which goes through `handle.checkForUpdatesNow()` — both delegate to
  // `runMenuDrivenCheck`, so both pop the `showCheckNowResult` dialog
  // (production: `dialog.showMessageBox`).
  register('ok:update:check-now', (_event: IpcMainInvokeEvent): undefined => {
    void runMenuDrivenCheck();
    return undefined;
  });

  // One window dismissed the what's-new notice (X click or 60s auto-expiry).
  // Clear the live notice first so a window opened afterwards (or mid-broadcast)
  // no longer receives it, then re-broadcast to every window so they all clear
  // in lockstep. The version guard leaves a newer live notice untouched if a
  // stale dismiss for an older version arrives.
  register(
    'ok:update:whats-new-dismiss',
    (_event: IpcMainInvokeEvent, payload: { version: string }): undefined => {
      const version = typeof payload?.version === 'string' ? payload.version : '';
      if (activeWhatsNew && activeWhatsNew.version === version) {
        activeWhatsNew = null;
      }
      broadcastToAllWindows('ok:update:whats-new-dismissed', { version });
      onDispatch?.('whats-new-dismiss-broadcast');
      return undefined;
    },
  );

  // ————————————————————————————————————————————————————————
  // First-launch version notice (Toast B) detection
  // ————————————————————————————————————————————————————————

  const currentVersion = getAppVersion();
  let state = readState();

  // Snapshot the staging stamp before the stale-pending reconciliation below
  // can clear it. That reconciliation compares major.minor.patch only, so a
  // same-MMP beta bump — the dominant OK update shape — reads as "caught up"
  // and drops the stamp, while the prerelease-aware failed-install verdict
  // right after still sees an install that never landed. Only the re-offer log
  // line needs it now — it reports how long the artifact has sat staged — so
  // this is log fidelity rather than verdict soundness: a recorded handoff
  // lives in the `attemptedInstall` group, which this reconciliation does not
  // touch.
  const attemptStagedAt = state.versionPendingInstallStagedAt;

  // Boot-time stale-pending reconciliation. `versionPendingInstall` is cleared
  // by exactly one site (`ok:update:relaunch-now` IPC, the "Relaunch" button).
  // The other install path — `autoInstallOnAppQuit` (non-Linux; Linux keeps
  // only the explicit Relaunch path, see the assignment) — installs the
  // staged update when the user simply quits the app, but never touches the
  // state field. Next launch, `main/index.ts`'s `browser-window-created`
  // re-broadcast surfaces the stale value as a phantom "Version X ready to
  // install" toast for the version the app is already running. Clear the field
  // when the running version has caught up. Conservative default: malformed
  // inputs fall through `versionAtLeast` to `false`, so a parse failure leaves
  // a genuinely-pending update armed rather than dropping it on garbage.
  if (state.versionPendingInstall && versionAtLeast(currentVersion, state.versionPendingInstall)) {
    const cleared = state.versionPendingInstall;
    const next = {
      ...state,
      versionPendingInstall: null,
      stagedInstallerPath: null,
      versionPendingInstallStagedAt: null,
    };
    if (persistSafely(next, 'stale-pending-cleared')) {
      state = next;
      logger.info('cleared stale versionPendingInstall — running has caught up', {
        cleared,
        running: currentVersion,
      });
      onDispatch?.('stale-pending-cleared');
    }
  }

  // Boot-time failed-install detection. `attemptedInstall` is the version the
  // app committed to install (set at update-downloaded). It survives the
  // `relaunch-now` clear of `versionPendingInstall`, so a clean quit whose
  // post-quit install never happened — e.g. Squirrel.Mac's ShipIt failing to
  // run after the app exited — is detectable HERE even though no live process
  // ever saw the failure. The synchronous-throw path and the 15s no-quit
  // watchdog both require the process to still be alive; for a clean quit they
  // never fire, leaving the next boot as the only detection point. Uses the
  // prerelease-aware `installReached` (not the MMP-only `versionAtLeast`) so a
  // same-major.minor.patch beta bump is not misread as "caught up".
  // True when THIS boot exhausted the failed-install surfacing budget and
  // dropped the record. Blocks the staged-cache reclaim below for one boot:
  // the giveup clears both state gates, but the user may still be acting on
  // the failure notice (e.g. running the Linux manual-install command against
  // the staged installer).
  let installGaveUpThisBoot = false;
  if (state.attemptedInstall) {
    const attempted = state.attemptedInstall;
    if (installReached(currentVersion, attempted)) {
      // Running reached the attempted version → install succeeded. Clear the
      // record; the "Updated to Version ..." notice (Toast B, below) handles
      // the success surface.
      // The age describes `attemptedInstall`; clearing one without the other
      // leaves `state.json` self-contradictory for the triage read the whole
      // record exists to serve. Same pairing as the cross-channel and give-up
      // branches below.
      const next = {
        ...state,
        attemptedInstall: null,
        attemptedInstallSurfacedCount: 0,
        attemptedInstallStagingAgeMs: null,
        attemptedInstallHandoffAt: null,
        attemptedInstallDeferredBoots: 0,
      };
      if (persistSafely(next, 'attempted-install-reconciled')) {
        state = next;
        onDispatch?.('attempted-install-reconciled');
      } else {
        // Write failed — `attemptedInstall` stays armed (the next boot
        // reconciles again). Log with the version pair, matching the failure
        // branch's diagnostic, so a record persisting across boots is traceable.
        logger.warn('failed to persist attempted-install-reconciled', {
          attempted,
          running: currentVersion,
        });
      }
    } else if (channelFromVersion(attempted) !== channelFromVersion(currentVersion)) {
      // Cross-channel residue, reached only once the running version has NOT
      // caught up to `attempted` (a legitimate stable-over-beta move reconciles
      // as success above). `state.json` lives in the Electron userData dir keyed
      // by `appId`/`productName`, both identical for the stable and beta builds,
      // so the two channels share one state file. A build on one channel that
      // armed `attemptedInstall` before the user switched to the other channel's
      // build (they overwrite the same `/Applications/OpenKnowledge.app`) leaves
      // a record the running channel can NEVER reconcile: it only downloads its
      // own channel's versions, and the `update-available` cross-channel veto
      // blocks the other channel's version outright — so `installReached` stays
      // false and the card would re-fire every boot forever. Clear it silently:
      // "Update to <stable 0.23.0> didn't install" on a beta build (or vice
      // versa) is a false signal about an install that was never this channel's
      // to run. Drop `versionPendingInstall` too: a stale cross-channel pending
      // marker survives the MMP-only stale-pending reconciliation when the two
      // channels' MMPs differ, and would otherwise leave a phantom "ready to
      // install" banner behind.
      const next = {
        ...state,
        attemptedInstall: null,
        attemptedInstallSurfacedCount: 0,
        versionPendingInstall: null,
        stagedInstallerPath: null,
        versionPendingInstallStagedAt: null,
        attemptedInstallStagingAgeMs: null,
        attemptedInstallHandoffAt: null,
        attemptedInstallDeferredBoots: 0,
      };
      if (persistSafely(next, 'attempted-install-cross-channel')) {
        state = next;
        logger.info('cleared cross-channel attemptedInstall residue', {
          attempted,
          running: currentVersion,
        });
        onDispatch?.('attempted-install-cross-channel');
      }
    } else if (updatesEnabled) {
      // Gated on `updatesEnabled`: in a dev build a non-reached attemptedInstall
      // is stale dev/test residue, not a real failed install — leave it armed
      // (a later production build reconciles it) but don't surface the notice.

      // Running did NOT reach the attempted version — which is equally the
      // expected state while the install for it is still underway, so the two
      // have to be separated before either failure verdict below is reachable.
      //
      // The chain asks two questions in this order, and the order is
      // load-bearing. FIRST, could an install still be running? While it could,
      // decide nothing. Only once it provably cannot: was one ever handed off
      // at all? A no there is not a failure, so it is re-offered rather than
      // condemned.
      const reconciledAtMs = now().getTime();
      // Two reads, because those two questions want different things. The
      // RESOLVED moment (stamp, else the staging snapshot) bounds "may still be
      // running", and comes from the same helper `installMayStillBeRunning`
      // uses so the two cannot disagree about it. The RAW stamp answers "was
      // one ever handed off", which the fallback would erase — an unobserved
      // quit has no stamp yet still gets a bound, which is the whole point of
      // the fallback and the whole reason the raw read has to survive it.
      const handoffStampedAt = state.attemptedInstallHandoffAt;
      const handoffAt = resolveInstallHandoffMoment(state, attemptStagedAt);
      const handoffAgeMs = installHandoffAgeMs(handoffAt, reconciledAtMs);
      if (installMayStillBeRunning(state, reconciledAtMs, attemptStagedAt) !== null) {
        // Inside the install window, and the hold has boots left: decide
        // nothing about the attempt. `attemptedInstall` stays armed so a later
        // boot still reconciles it as success or as failure,
        // `versionPendingInstall` is not re-armed behind an install that is
        // about to land, and the surfacing budget stays unspent so user
        // impatience cannot exhaust the notice before the real verdict is due.
        // Deferring is also the only direction that can be wrong cheaply: on
        // Squirrel.Mac the reopen is itself what aborts the swap, and an
        // aborted attempt re-stages, so the install this boot would condemn is
        // the one that lands on the next quit.
        //
        // The one thing the boot does record is that it held — the count is
        // what survives a same-version re-arm clearing the handoff stamp, so
        // without writing it the hold has nothing to terminate on.
        const next = {
          ...state,
          attemptedInstallDeferredBoots: state.attemptedInstallDeferredBoots + 1,
        };
        if (persistSafely(next, 'install-in-flight-deferred')) {
          state = next;
        } else {
          // Still defer: a write failure is no reason to condemn an install
          // that may be landing. The bound just does not advance this boot, so
          // log the pair the way the reconciliation branch does — a count that
          // never moves across boots is how this shows up in a field report.
          logger.warn('failed to persist install-in-flight-deferred', {
            attempted,
            running: currentVersion,
          });
        }
        // Logged at info, like the sibling reconciliation branches — a held
        // verdict is an expected outcome, and this line is the only trace of it
        // since a deferred boot is silent to the user.
        logger.info('attempted install may still be running — deferring the failure verdict', {
          attempted,
          running: currentVersion,
          handoffAgeMs,
          // The instant `handoffAgeMs` was derived from, plus how long the
          // artifact had sat staged when it was committed. A deferred boot is
          // silent to the user, so this line is the only record of a held
          // verdict — carrying the inputs is what lets an operator reading a
          // "my update never installed" report see which handoff moment the
          // hold was measured from. This arm runs BEFORE the never-committed
          // check, so it is the one place the staging fallback is still live and
          // `recordedHandoff` still varies — a hold leaning on the staging
          // moment reads `false` here.
          handoffAt,
          recordedHandoff: state.attemptedInstallHandoffAt !== null,
          stagingAgeMs: state.attemptedInstallStagingAgeMs,
          surfaced: state.attemptedInstallSurfacedCount,
          // How much of the hold this attempt has spent, after this boot. Reads
          // the effective count rather than the intended one, so a bound that
          // stops advancing (a failing persist) is visible from the log alone.
          deferredBoots: state.attemptedInstallDeferredBoots,
        });
        onDispatch?.('install-in-flight-deferred');
      } else if (handoffStampedAt === null) {
        // No commit point ever ran for this attempt, so no install was ever
        // STARTED — a different fact from "an install began and we lost track
        // of when it did". Both commit points persist the handoff stamp BEFORE
        // handing the artifact to an installer: `relaunch-now` writes it and
        // returns early if that write fails, and `recordInstallHandoffOnQuit`
        // runs from `before-quit`, ahead of the swap. A null stamp is therefore
        // evidence that nothing was handed off, not a gap in the record.
        //
        // The shape that produces it in the field is win32: Windows ends the
        // session with `WM_ENDSESSION` and terminates the process without
        // running `will-quit`, so install-on-quit never fires. A user who shuts
        // the machine down rather than quitting the app hits it every time —
        // and, being the delivery vehicle for its own fixes, the app can never
        // repair that from a later release.
        //
        // Reasoning about install duration here would condemn (or excuse) an
        // install that does not exist, and charging it against
        // INSTALL_FAILURE_MAX_SURFACES is worse than a wrong message: three OS
        // shutdowns spend the budget, the give-up branch drops the record, and
        // the user is left with no offer at all while the artifact is still
        // staged on disk. So decline to judge, and put the update that IS still
        // staged back on offer through the ordinary consented path.
        //
        // Three shapes reach here with a stamp that is null for a reason other
        // than "the session never committed": a `state.json` written by a build
        // predating the stamp; a quit whose stamp write failed, which
        // `recordInstallHandoffOnQuit` logs before letting the quit proceed,
        // since it cannot decline a quit the way `relaunch-now` declines a
        // click; and electron-updater re-arming `update-downloaded` from its
        // on-disk cache, which clears the stamp under a live install.
        //
        // That third one is why this arm sits AFTER the in-flight deferral
        // rather than ahead of it: re-offering into an install that is still
        // running would hand the user a relaunch that aborts the swap already
        // underway. Past the grace none of them can still be installing, so the
        // cost collapses — if the install landed, the next boot reconciles it as
        // success; if it did not, the user is offered the relaunch instead of
        // being told the install failed, which is the same remedy behind a
        // truer message.
        const next = {
          ...state,
          // `attemptedInstall` stays ARMED. On non-Linux `relaunch-now` does not
          // arm it — only the `platform === 'linux'` spread does — so it is the
          // download-time arming that the post-click failure path depends on.
          // Withdrawing it here would disarm failed-install detection for the
          // very click this branch exists to offer: an install that then did not
          // land would find both gates null on the next boot, surfacing no
          // notice and no manual-download URL, and the staged-cache reclaim
          // would delete the artifact underneath it. Leaving it armed also costs
          // nothing, because the null-stamp test above runs every boot: the
          // re-offer simply repeats, and the budget stays unspent.
          //
          // The artifact is still staged, so re-arm the banner gate the ordinary
          // download path would have left armed. `stagedInstallerPath` is
          // deliberately untouched — it is what makes the offer actionable.
          versionPendingInstall: attempted,
        };
        if (persistSafely(next, 'install-never-committed-reoffered')) {
          state = next;
          logger.info('no commit point ran for the staged install — re-offering it', {
            attempted,
            running: currentVersion,
            // How long the artifact has been sitting staged and un-installed.
            // A large value across boots is the stranding signature: sessions
            // keep ending in a way that never commits, and the sole trace of it
            // is this line.
            stagedAgeMs: installHandoffAgeMs(attemptStagedAt, reconciledAtMs),
          });
          // Deferred for the same reason as Toast A/B/C: `startAutoUpdater` runs
          // from `app.whenReady()`, before the first renderer has attached its
          // update listeners, so a synchronous broadcast would be dropped.
          const fireReoffer = (): void => {
            broadcastToAllWindows('ok:update:downloaded', { version: attempted });
          };
          if (whenRendererReady) whenRendererReady(fireReoffer);
          else fireReoffer();
          onDispatch?.('install-never-committed-reoffered');
        } else {
          // Write failed — leave `attemptedInstall` armed so the next boot
          // re-decides rather than silently losing the record. Version-identified
          // so a record persisting across boots is traceable, matching the
          // sibling branches.
          logger.warn('failed to persist install-never-committed-reoffered', {
            attempted,
            running: currentVersion,
          });
        }
        // Past here a handoff IS on record, so an install really was handed to
        // an installer and the only open question is its age.
        //
        // The predicate itself lives in `installMayStillBeRunning` so crash
        // detection can ask the same question with the same bound; the locals
        // above stay for the log lines, which report the inputs the verdict was
        // reached from rather than the verdict alone.
      } else if (state.attemptedInstallSurfacedCount >= INSTALL_FAILURE_MAX_SURFACES) {
        // Budget spent — drop `attemptedInstall` so a persistently-failing
        // ShipIt or an unreachable attempted version (a yanked release, a
        // channel move) stops re-firing the notice on every boot. The 7-day
        // stuck-hint (Toast C) remains the backstop if update checks also stall.
        // Drop `versionPendingInstall` too: after giving up, a stale pending
        // marker for a higher-MMP attempted version survives the MMP-only
        // stale-pending reconciliation and would leave a phantom "ready to
        // install" banner (and dedup-block a genuine re-download).
        const next = {
          ...state,
          attemptedInstall: null,
          attemptedInstallSurfacedCount: 0,
          versionPendingInstall: null,
          stagedInstallerPath: null,
          versionPendingInstallStagedAt: null,
          attemptedInstallStagingAgeMs: null,
          attemptedInstallHandoffAt: null,
          attemptedInstallDeferredBoots: 0,
        };
        if (persistSafely(next, 'install-failed-giveup')) {
          state = next;
          installGaveUpThisBoot = true;
          logger.warn('attempted install exhausted its retry budget — clearing record', {
            attempted,
            running: currentVersion,
            surfaced: INSTALL_FAILURE_MAX_SURFACES,
            handoffAgeMs,
          });
          onDispatch?.('install-failed-giveup');
        }
      } else {
        // Persist-before-emit: re-arm `versionPendingInstall` (so the notice's
        // Retry can re-trigger the still-staged update through the existing
        // `relaunch-now` gate) and bump the surface counter BEFORE surfacing the
        // notice. Keep `attemptedInstall` armed — the expectation "running
        // should be `attempted`" still holds, and a broken install rarely
        // self-heals on one Retry (e.g. a persistently-failing ShipIt). Clearing
        // it here would make the SECOND failure silent again: `relaunch-now`
        // clears `versionPendingInstall` and does not re-set `attemptedInstall`,
        // so the next boot would have neither signal. Leaving it set re-surfaces
        // the failure each boot, up to INSTALL_FAILURE_MAX_SURFACES, until the
        // install actually takes — the success branch above clears it once
        // `installReached` is satisfied.
        const next = {
          ...state,
          versionPendingInstall: attempted,
          attemptedInstallSurfacedCount: state.attemptedInstallSurfacedCount + 1,
        };
        if (persistSafely(next, 'install-failed-on-boot')) {
          state = next;
          logger.warn('attempted install did not take — surfacing failure notice', {
            attempted,
            running: currentVersion,
            surfaced: next.attemptedInstallSurfacedCount,
            // Null when the commit that stamped the handoff left no staging age
            // behind — the clock moved backwards between staging and the
            // commit, or a boot's stale-pending reconciliation had already
            // dropped the staging stamp. A zero would read as an instant
            // install, so unknown is reported as unknown.
            stagingAgeMs: state.attemptedInstallStagingAgeMs,
            // Always present: the reconciliation reaches this line only with a
            // stamp on record. A null `handoffAgeMs` beside it therefore means
            // exactly one thing — the clock moved backwards between the handoff
            // and this boot.
            handoffAt,
            // How long ago the install was handed off, which the staging age
            // cannot say: it measures staged-to-request, not request-to-now.
            // Null means the timing on record could not be reasoned from, and
            // the verdict fired on the fail-closed path.
            handoffAgeMs,
          });
          // Reuse the relaunch-failed channel: both mean "a committed update did
          // not install". The boot-detected case carries a `downloadUrl` so the
          // renderer can offer the richer "Retry / Download manually" card; the
          // in-session failRelaunch path omits it and keeps its existing message.
          // Deferred through `whenRendererReady` for the same reason as Toast A/B/C:
          // `startAutoUpdater` runs from `app.whenReady()`, before the first
          // window's renderer has attached its update-notice listener — a
          // synchronous broadcast would be dropped. Tests inject no scheduler and
          // get the immediate-fire path.
          const fireInstallFailed = (): void => {
            broadcastToAllWindows('ok:update:relaunch-failed', {
              version: attempted,
              downloadUrl: STUCK_HINT_DOWNLOAD_URL,
            });
          };
          if (whenRendererReady) whenRendererReady(fireInstallFailed);
          else fireInstallFailed();
          onDispatch?.('install-failed-on-boot');
        }
      }
    }
  }

  // `lastSeenVersion === null` means a fresh install: seed the baseline
  // silently — a new installer has no prior version, so an "Updated to
  // Version ..." notice is noise. Toast B fires only on a real transition.
  const shouldShowVersionNotice =
    state.lastSeenVersion !== null && state.lastSeenVersion !== currentVersion;
  const needsStateAdvance = state.lastSeenVersion !== currentVersion;

  // Arriving on a new build starts the quiet window. Armed off the same
  // condition as the what's-new notice so the two agree by construction:
  // whenever we tell the user "Updated to Version X", we also stop asking them
  // to update again for a while. A fresh install (`lastSeenVersion === null`)
  // is deliberately excluded — nobody just sat through an update, and the
  // installer is often already a release or two behind.
  //
  // Gated on install-on-quit, which is what makes deferring the banner free:
  // the update still lands at the next quit, so only the interruption moves.
  // Where install-on-quit is off (Linux), the banner is not a notification at
  // all, it is the sole install affordance — holding it would withhold the
  // only way to apply the update and leave the build staged and uninstalled.
  if (shouldShowVersionNotice && updater.autoInstallOnAppQuit) {
    postUpdateQuietUntil = now().getTime() + POST_UPDATE_QUIET_MS;
    logger.info('post-update quiet window armed', {
      from: state.lastSeenVersion,
      to: currentVersion,
      untilMs: postUpdateQuietUntil,
    });
  }

  // Persist-before-emit — advance
  // `lastSeenVersion` BEFORE any broadcast so a disk-write failure cannot
  // leave Toast B un-armed-with-broadcast-already-sent (which would re-fire
  // on every boot). Peer sites (Toast A, Toast C) use this same order.
  if (needsStateAdvance) {
    const advanced = persistSafely(
      { ...state, lastSeenVersion: currentVersion },
      'lastSeenVersion-advance',
    );
    if (advanced && shouldShowVersionNotice && updatesEnabled) {
      // `updatesEnabled` gate: suppress the release-notes toast in dev builds.
      // `lastSeenVersion` still advances above, so it stays silent on the next
      // boot too rather than re-firing.
      // Toast B fans out to every window (see `fireToastB`), safe because the
      // notice clears across all windows on dismiss. Deferred via
      // `whenRendererReady` when provided (renderer-mount race): `startAutoUpdater`
      // runs from `app.whenReady()`, which fires BEFORE the first window's
      // renderer has mounted `<UpdateToast/>` and attached its preload-side
      // listener via the bridge subscription method. A synchronous
      // `webContents.send` at this point is dropped. Production passes a
      // scheduler that waits for `did-finish-load` on the primary window;
      // tests that don't care inject `undefined` and get the immediate-fire
      // behavior.
      const fireToastB = (): void => {
        const releaseUrl = releaseUrlFor(currentVersion);
        // Mark the notice live so a window opened within the live window picks
        // it up via `getActiveWhatsNew` (the `browser-window-created` re-send in
        // main/index.ts).
        activeWhatsNew = { version: currentVersion, releaseUrl, firedAt: now().getTime() };
        broadcastToAllWindows('ok:update:whats-new', {
          version: currentVersion,
          releaseUrl,
        });
        logger.info('whats-new dispatched Toast B (all windows)', {
          from: state.lastSeenVersion,
          to: currentVersion,
        });
        onDispatch?.('whats-new-toast-b');
      };
      if (whenRendererReady) whenRendererReady(fireToastB);
      else fireToastB();
    }
  }

  // ————————————————————————————————————————————————————————
  // Staged-cache reclaim — strictly after the reconciliation above
  // ————————————————————————————————————————————————————————

  // Seed the in-memory staged-installer path from the reconciled state: the
  // reconciliation above already nulled it wherever the staged update
  // stopped being live, so what survives here is a genuinely-pending
  // installer the Linux fallback may need before the launch check re-emits
  // update-downloaded from cache.
  stagedInstallerPath = state.stagedInstallerPath;

  // With every install commitment settled (no pending banner to restore, no
  // failed install being surfaced or retried), the staged installer in
  // electron-updater's `pending/` cache has no remaining job: either it
  // installed (this boot runs it) or nothing was ever staged. Any armed gate
  // means the file may still be needed — the Linux "Relaunch" path, the
  // manual-install fallback command, and the boot failure notice's Retry all
  // consume it — so reclaim is skipped and re-evaluated next boot.
  //
  // When a reclaim dispatched, the launch check below chains off this
  // promise so the recursive delete of `pending/` can never race a fresh
  // download re-creating the directory. Null when no reclaim ran — the
  // launch check then fires with its usual immediate timing. Never rejects.
  let reclaimSettled: Promise<void> | null = null;
  if (
    reclaimStagedUpdateCache &&
    state.versionPendingInstall === null &&
    state.attemptedInstall === null &&
    !installGaveUpThisBoot
  ) {
    try {
      reclaimSettled = Promise.resolve(reclaimStagedUpdateCache()).then(
        () => undefined,
        (err: unknown) => {
          logger.warn('staged-update cache reclaim failed', { err });
        },
      );
      // Dispatch records "reclaim branch taken", not "rm settled" — matching
      // the module-wide onDispatch convention; the failure path only logs.
      onDispatch?.('staged-cache-reclaimed');
    } catch (err) {
      logger.warn('staged-update cache reclaim threw synchronously', { err });
    }
  }

  // ————————————————————————————————————————————————————————
  // Launch check + periodic timer (hourly + jitter)
  // ————————————————————————————————————————————————————————

  // Self-rescheduling `setTimeout` rather than a fixed `setInterval`: each
  // tick draws a fresh jitter so the cadence never re-synchronizes across the
  // install base (see UPDATE_CHECK_JITTER_MS). One timer per app launch —
  // there is a single Electron main process regardless of how many project
  // windows are open, so this is the only periodic release check system-wide.
  let timerHandle: ReturnType<typeof setTimeout> | null = null;

  const nextCheckDelayMs = (): number =>
    UPDATE_CHECK_INTERVAL_MS + Math.floor(random() * UPDATE_CHECK_JITTER_MS);

  const scheduleNextCheck = (): void => {
    const delayMs = nextCheckDelayMs();
    timerHandle = clock.setTimeout(() => {
      // Clear the handle before the body runs so a `destroy()` that lands
      // after this tick fires but before `scheduleNextCheck()` re-arms
      // doesn't try to clear a timeout that already elapsed.
      timerHandle = null;
      void updater.checkForUpdates().catch((err: unknown) => {
        // checkForUpdates rejects on network / manifest errors; the updater
        // also emits `error` for these, so the catch here is just a defensive
        // log. Event handlers run either way.
        logger.debug('checkForUpdates rejected', {
          err,
        });
      });
      scheduleNextCheck();
    }, delayMs);
    logger.debug('next update check scheduled', { delayMs });
  };

  const startPeriodicChecks = (): void => {
    // Caller is guaranteed to invoke startAutoUpdater once per app launch;
    // guard against accidental re-entry so we never run two timers.
    if (timerHandle) return;
    scheduleNextCheck();
  };

  const runLaunchCheck = (): void => {
    void updater
      .checkForUpdates()
      .then(() => {
        startPeriodicChecks();
      })
      .catch((err: unknown) => {
        logger.debug('first-launch checkForUpdates rejected', {
          err,
        });
        // If the proxy feed caused it, revert to GitHub and re-check once.
        revertToGithubFeed('first-check-rejected');
        // Still start the timer — the next fire may succeed.
        startPeriodicChecks();
      });
  };

  if (updatesEnabled) {
    if (reclaimSettled) {
      // Sequenced after the reclaim so the boot-time delete of `pending/`
      // cannot interleave with a fresh download re-creating it.
      void reclaimSettled.then(runLaunchCheck);
    } else {
      runLaunchCheck();
    }
  } else {
    logger.info(
      'skipping checkForUpdates — app.isPackaged=false and OK_UPDATER_FORCE_DEV unset (handlers remain wired for tests + IPC)',
    );
    onDispatch?.('skipped-dev-mode');
  }

  // ————————————————————————————————————————————————————————
  // Teardown (cleared on will-quit)
  // ————————————————————————————————————————————————————————

  return {
    checkForUpdatesNow(): Promise<unknown> {
      logger.info('check-now invoked from menu');
      return runMenuDrivenCheck();
    },
    getActiveWhatsNew(): { version: string; releaseUrl: string } | null {
      if (!activeWhatsNew) return null;
      // Gate on the live window: a window opened long after the update — with
      // every earlier window closed, so no renderer auto-dismiss ever fired to
      // clear the flag — must not get a stale card.
      if (now().getTime() - activeWhatsNew.firedAt >= WHATS_NEW_LIVE_WINDOW_MS) {
        return null;
      }
      return { version: activeWhatsNew.version, releaseUrl: activeWhatsNew.releaseUrl };
    },
    isWithinPostUpdateQuietWindow(): boolean {
      return withinPostUpdateQuietWindow();
    },
    suppressAutoInstallOnQuit(): void {
      updater.autoInstallOnAppQuit = false;
      logger.info('autoInstallOnAppQuit suppressed for uninstall');
    },
    recordInstallHandoffOnQuit(): void {
      // Install-on-quit is what makes an ordinary quit a handoff at all. Off on
      // Linux, and turned off for the uninstall quit — neither of those quits
      // installs anything, so neither gets to claim a handoff moment.
      if (!updater.autoInstallOnAppQuit) return;
      const current = readState();
      // No install is committed, so this quit hands nothing off.
      if (current.attemptedInstall === null) return;
      // Already stamped — by the "Relaunch now" click, or by an earlier quit
      // that handed the same staging off. Not refreshed; see the interface doc.
      if (current.attemptedInstallHandoffAt !== null) return;
      const handoffAt = now().getTime();
      // How long the artifact had sat staged when this quit committed it —
      // diagnostic only, and unavailable once a boot's stale-pending
      // reconciliation has dropped the staging stamp. Same coercion the click
      // path makes: a non-positive delta means the wall clock moved backwards
      // since staging, not an instant handoff.
      const stagedAt = current.versionPendingInstallStagedAt;
      const rawStagingAge = stagedAt === null ? null : handoffAt - stagedAt;
      const stagingAgeMs = rawStagingAge !== null && rawStagingAge > 0 ? rawStagingAge : null;
      if (
        persistSafely(
          {
            ...current,
            attemptedInstallHandoffAt: handoffAt,
            attemptedInstallStagingAgeMs: stagingAgeMs,
          },
          'handoff-on-quit',
        )
      ) {
        logger.info('quit commits the staged install — recording the handoff moment', {
          attempted: current.attemptedInstall,
          handoffAt,
          stagingAgeMs,
        });
      } else {
        // This quit installs anyway — the write failing is no reason to decline
        // it — so the next boot sees an install that really was handed off
        // carrying no stamp, and re-offers the update rather than judging the
        // attempt. That is the benign direction, but it is a false negative for
        // failed-install detection and the only trace of it is this line.
        logger.warn('failed to persist install handoff moment — next boot will re-offer', {
          attempted: current.attemptedInstall,
          handoffAt,
          stagingAgeMs,
        });
      }
    },
    destroy(): void {
      if (timerHandle) {
        clock.clearTimeout(timerHandle);
        timerHandle = null;
      }
      if (relaunchInFlight) {
        clock.clearTimeout(relaunchInFlight.watchdog);
        relaunchInFlight = null;
      }
      if (quietWindowTimer) {
        clock.clearTimeout(quietWindowTimer);
        quietWindowTimer = null;
      }
      // Release anything still awaiting the freshness check so a relaunch
      // click that raced teardown resolves now instead of sitting out its
      // full timeout against a torn-down updater.
      settleCheckWaiters('settled');
      stagingInFlight = null;
      settleStagingWaiters(false);
      // Note: listeners detached per-event below.
      // Detach each listener under its own try/catch — a single `updater.off`
      // throw must not leave the remaining subscribers wired. electron-
      // updater extends Node's EventEmitter so `off` is unlikely to throw,
      // but teardown is exactly where defensive code earns its keep.
      const detach = (event: string, handler: (...args: unknown[]) => void): void => {
        try {
          updater.off(event, handler);
        } catch (err) {
          logger.warn('updater.off failed during destroy', {
            event,
            err,
          });
        }
      };
      detach('checking-for-update', onCheckingForUpdate as (...args: unknown[]) => void);
      detach('update-available', onUpdateAvailable as (...args: unknown[]) => void);
      detach('update-available', onUpdateAvailableForMenuCheck as (...args: unknown[]) => void);
      detach('update-not-available', onUpdateNotAvailable as (...args: unknown[]) => void);
      detach('download-progress', onDownloadProgress as (...args: unknown[]) => void);
      detach('update-downloaded', onUpdateDownloaded as (...args: unknown[]) => void);
      detach('error', onError as (...args: unknown[]) => void);
      const removeHandlerSafely = (channel: string): void => {
        try {
          ipcMain.removeHandler(channel);
        } catch (err) {
          logger.warn('ipcMain.removeHandler failed during destroy', {
            channel,
            err,
          });
        }
      };
      removeHandlerSafely('ok:update:relaunch-now');
      removeHandlerSafely('ok:update:check-now');
      removeHandlerSafely('ok:update:whats-new-dismiss');
      logger.info('destroyed');
    },
  };
}

/**
 * Shape returned by `() => import('electron-updater')`. The npm package is
 * published as CommonJS with the `autoUpdater` member installed via
 * `Object.defineProperty(exports, 'autoUpdater', { get: ... })` — a dynamic
 * getter that Node's CJS → ESM interop wraps behind `.default` when loaded
 * via `await import(...)`. Static named exports (AppUpdater, MacUpdater, …)
 * are also re-exposed at the top level, but `autoUpdater` is NOT. We must
 * read it off `.default`, with the top-level path kept as a fallback for
 * test mocks that still pass `{ autoUpdater }` directly.
 *
 * See electron-updater `out/main.js` for the `Object.defineProperty` site.
 */
interface ElectronUpdaterModule {
  autoUpdater?: UpdaterLike;
  default?: { autoUpdater?: UpdaterLike };
}

/**
 * Resolve `autoUpdater` from the imported module across both the real
 * CJS-wrapped-by-ESM shape and the flat shape used by test mocks. Returns
 * `null` if neither path exposes the member so the caller can log + bail
 * cleanly instead of throwing on the subsequent property assignment.
 */
function resolveAutoUpdater(mod: ElectronUpdaterModule): UpdaterLike | null {
  return mod.default?.autoUpdater ?? mod.autoUpdater ?? null;
}

/**
 * Catch-path-tested wrapper around the dynamic `electron-updater` import +
 * `startAutoUpdater` call. A failed dynamic import
 * (bundling drift, corrupt node_modules, future Electron upgrade that
 * desyncs electron-updater) must not crash the boot or leave the app
 * silently un-updateable with no user-facing or log signal. This helper
 * centralizes the try/catch contract so `main/index.ts` boot code stays
 * one line AND the catch branch is reachable from a `bun test` harness
 * without an Electron runtime.
 *
 * Tests pass a throwing `importUpdater` OR a flat `{ autoUpdater }` mock +
 * a captured logger; production passes `() => import('electron-updater')`
 * which resolves via `mod.default.autoUpdater` (see ElectronUpdaterModule).
 */
export async function bootAutoUpdater(
  importUpdater: () => Promise<ElectronUpdaterModule>,
  opts: Omit<StartAutoUpdaterOpts, 'updater'>,
): Promise<StartAutoUpdaterHandle | null> {
  const logger = opts.logger ?? DEFAULT_LOGGER;
  try {
    const mod = await importUpdater();
    const autoUpdater = resolveAutoUpdater(mod);
    if (!autoUpdater) {
      throw new Error(
        "electron-updater did not expose 'autoUpdater' on either the module namespace or .default — check electron-updater version + Node ESM-CJS interop",
      );
    }
    return startAutoUpdater({ updater: autoUpdater, ...opts });
  } catch (err) {
    logger.error('auto-updater boot failed — app will run without updates this session', {
      err,
    });
    return null;
  }
}
