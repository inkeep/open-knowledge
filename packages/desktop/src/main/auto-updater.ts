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
 * fires every `UPDATE_CHECK_INTERVAL_MS` (5 min while the update flow is being
 * validated pre-release; restore to hourly before GA) plus a fresh per-fire
 * random jitter in `[0, UPDATE_CHECK_JITTER_MS)` (~30 s). The jitter
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
  on(event: 'update-downloaded', listener: (info: { version?: string }) => void): this;
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
  | 'install-failed-on-boot'
  | 'install-failed-giveup'
  | 'attempted-install-cross-channel'
  | 'cross-channel-blocked';

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
   * project-window utility process. Squirrel.Mac's pre-swap check
   * runs `pgrep` against the bundle path and aborts with
   * `SQRLInstallerErrorDomain Code=-9 "App Still Running Error"` if
   * any utility is still alive when the swap window opens — the
   * standard `app.quit()` path posts a graceful `{type:'shutdown'}`
   * to each utility, but Hocuspocus / file-watcher cleanup can take
   * longer than ShipIt's poll budget, leaving the swap silently
   * cancelled. SIGKILLing the utilities first guarantees a clean
   * process tree before ShipIt looks. Optional so unit tests don't
   * have to provide one — production passes
   * `async () => await windowManager.stopAllOwnedServers()`. May be
   * async — the hook is awaited before `quitAndInstall` so a two-phase
   * shutdown (SIGTERM → poll → SIGKILL) can complete cleanly.
   */
  prepareForRelaunch?: () => void | Promise<void>;
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
 * Currently 5 minutes — intentionally short while the auto-update flow is still
 * being exercised pre-release (a 1-hour wait between checks makes manual
 * update-flow testing impractical). Restore to hourly (`60 * 60 * 1000`,
 * matching Obsidian's cadence) and bump the jitter back to ~5 min once the flow
 * has been validated in the field.
 */
export const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Upper bound on the random jitter added to each periodic-check delay. A fresh
 * value in `[0, UPDATE_CHECK_JITTER_MS)` is drawn per fire and added to
 * `UPDATE_CHECK_INTERVAL_MS`, so checks land somewhere in
 * `[UPDATE_CHECK_INTERVAL_MS, UPDATE_CHECK_INTERVAL_MS + 30 s)` after the
 * previous one — never sooner than the base interval, but spread across a
 * ~30-second window so an install base that booted together (or all woke from
 * sleep at the same wall-clock instant) doesn't re-synchronize onto GitHub's
 * release-metadata endpoint. Kept a small fraction of the base interval so
 * "every N minutes" still roughly holds, and scaled down alongside
 * `UPDATE_CHECK_INTERVAL_MS` (bump back to ~5 min when the base goes hourly).
 * Magnitude is plenty regardless: the check is a small HTTPS GET of
 * `latest-mac.yml` against a CDN-fronted public repo, so any minutes-or-less
 * spread is negligible load — the point is to break lockstep, not rate-limit.
 */
export const UPDATE_CHECK_JITTER_MS = 30 * 1000;

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
 * "Download manually" target for the stuck-hint and boot-detected install-failed
 * notices. Points at the GitHub Releases index, the canonical home of the signed
 * DMGs (same host as `releaseUrlFor` and the app's `OK_DESKTOP_INSTALL_URL`). The
 * index page, unlike a version-specific tag URL, is guaranteed to exist and lists
 * the latest download at the top, so the manual-download escape hatch can never
 * itself 404.
 */
export const STUCK_HINT_DOWNLOAD_URL = 'https://github.com/inkeep/open-knowledge/releases';

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
    forceDevBypass = false,
    feedUrl,
    proxyFeed,
    whenRendererReady,
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
  updater.autoInstallOnAppQuit = true;
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
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    logger.warn('proxy feed failed — reverted to GitHub provider for this session', { cause });
    void updater.checkForUpdates().catch((err: Error & { code?: string }) => {
      // Match the module's classified/unclassified discipline: a GitHub outage
      // right after the proxy one is operationally relevant, not debug noise.
      const ctx = {
        code: err?.code,
        message: err instanceof Error ? err.message : String(err),
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
        message: err instanceof Error ? err.message : String(err),
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
   * the sync-throw path runs before the in-flight gate arms, `onError`
   * gates on `relaunchInFlight`, and the first failure clears both the
   * watchdog and the gate so neither async trigger can re-enter. A new
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
    if (
      persistSafely({ ...readState(), versionPendingInstall: version }, 'relaunch-failed-restore')
    ) {
      broadcastToAllWindows('ok:update:downloaded', { version });
    }
    broadcastToAllWindows('ok:update:relaunch-failed', { version, message });
    logger.warn('relaunch failed — restored pending install and re-armed windows', {
      version,
      kind,
      message,
      causeCode: cause?.code,
      causeStack: cause?.stack,
    });
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
        message: err instanceof Error ? err.message : String(err),
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
    const offerClass = classifyOffer(info.version);
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
      onDispatch?.('cross-channel-blocked');
      return;
    }
    markCheckSucceeded();
    // `autoDownload = false`, so we kick off the download explicitly only
    // after the channel-match check passes. Defensive catch: rejections also
    // surface through the `error` event handler, but a synchronous reject
    // before the event bus engages (rare: provider-construction failure
    // mid-flight) would only show up in this log line. Match
    // `runMenuDrivenCheck`'s classified/unclassified discipline so
    // classified codes land at `warn` with code + stack + timestamp.
    void updater.downloadUpdate().catch((err: unknown) => {
      const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
      const logFn = isClassifiedUpdaterError(err) ? logger.warn : logger.debug;
      logFn('downloadUpdate rejected', {
        code,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        timestamp: now().toISOString(),
      });
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
    showCheckNowResult?.({
      kind: 'available',
      currentVersion: getAppVersion(),
      latestVersion: typeof info.version === 'string' ? info.version : 'unknown',
    });
  };

  const onUpdateNotAvailable = (info: { version?: string }): void => {
    logger.info('update-not-available', { version: info.version });
    markCheckSucceeded();
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

  const onUpdateDownloaded = (info: { version?: string }): void => {
    logger.info('update-downloaded', { version: info.version });
    const version = typeof info.version === 'string' ? info.version : '';
    if (!version) {
      logger.warn('update-downloaded with empty version — skipping dispatch');
      onDispatch?.('update-downloaded-empty-version');
      return;
    }
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
    // Arm BOTH the banner gate (`versionPendingInstall`) and the boot-time
    // failure-detection record (`attemptedInstall`). With `autoInstallOnAppQuit`
    // the staged update is now committed to install on the next quit (whether
    // via "Relaunch now" or a plain quit), so this is the point the install is
    // "attempted". `attemptedInstall` survives the `relaunch-now` clear of
    // `versionPendingInstall`, letting the next boot tell success from a
    // silently-failed install.
    if (
      !persistSafely(
        {
          ...state,
          versionPendingInstall: version,
          attemptedInstall: version,
          // Fresh failure budget for a newly-attempted version; preserved when
          // the same version re-arms (e.g. a re-download after `relaunch-now`
          // cleared `versionPendingInstall`) so the boot-nag cap isn't reset.
          attemptedInstallSurfacedCount:
            state.attemptedInstall === version ? state.attemptedInstallSurfacedCount : 0,
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
    if (whenRendererReady) whenRendererReady(fireToastA);
    else fireToastA();
  };

  const onError = (err: Error & { code?: string }): void => {
    if (isClassifiedUpdaterError(err)) {
      logger.warn('error (classified)', {
        code: err.code,
        message: err.message,
        timestamp: now().toISOString(),
      });
      onDispatch?.('error-classified');
    } else {
      logger.error('error (unclassified)', {
        message: err.message,
        stack: err.stack,
        timestamp: now().toISOString(),
      });
      onDispatch?.('error-unclassified');
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
      failRelaunch(
        relaunchInFlight.version,
        err.message || 'update error during relaunch',
        'relaunch-error-event',
        { code: err.code, stack: err.stack },
      );
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
    const snapshot = readState();
    if (!snapshot.versionPendingInstall) {
      logger.warn('relaunch-now invoked without versionPendingInstall — ignoring');
      return undefined;
    }
    const pending = snapshot.versionPendingInstall;
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
    if (!persistSafely({ ...snapshot, versionPendingInstall: null }, 'relaunch-now'))
      return undefined;
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
    // in try/catch so a hook bug never blocks the user's relaunch — the
    // worst case if the hook throws is the original failure mode (Squirrel
    // pgrep aborts with code -9), which the user can recover from by
    // quitting the app manually. We log the throw so the diagnostic is
    // visible in main process stderr.
    if (opts.prepareForRelaunch) {
      try {
        await opts.prepareForRelaunch();
      } catch (err) {
        logger.warn('prepareForRelaunch threw — proceeding to quitAndInstall anyway', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    logger.info('relaunch-now invoked — calling autoUpdater.quitAndInstall', { pending });
    onDispatch?.('relaunch-now');
    try {
      updater.quitAndInstall();
    } catch (err) {
      // quitAndInstall threw — the app is NOT quitting. `failRelaunch`
      // recovers every window (restore gate + re-arm + failure notice);
      // rethrow so the clicked window's invoke also rejects and its
      // rejection-path notice lands (idempotent with the broadcast — same
      // version-keyed id).
      failRelaunch(
        pending,
        err instanceof Error ? err.message : String(err),
        'relaunch-failed-rearm',
      );
      throw err;
    }
    // quitAndInstall returned cleanly, but that proves nothing on
    // Squirrel.Mac — its failures surface asynchronously via the updater's
    // `error` event (handled in onError while in flight), or as a silent
    // no-quit. Arm the watchdog backstop for the latter: if this process is
    // still alive when the timer fires, the relaunch failed. Packaged builds
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

  // Boot-time stale-pending reconciliation. `versionPendingInstall` is cleared
  // by exactly one site (`ok:update:relaunch-now` IPC, the "Relaunch" button).
  // The other install path — `autoInstallOnAppQuit = true` — installs the
  // staged update when the user simply quits the app, but never touches the
  // state field. Next launch, `main/index.ts`'s `browser-window-created`
  // re-broadcast surfaces the stale value as a phantom "Version X ready to
  // install" toast for the version the app is already running. Clear the field
  // when the running version has caught up. Conservative default: malformed
  // inputs fall through `versionAtLeast` to `false`, so a parse failure leaves
  // a genuinely-pending update armed rather than dropping it on garbage.
  if (state.versionPendingInstall && versionAtLeast(currentVersion, state.versionPendingInstall)) {
    const cleared = state.versionPendingInstall;
    const next = { ...state, versionPendingInstall: null };
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
  if (state.attemptedInstall) {
    const attempted = state.attemptedInstall;
    if (installReached(currentVersion, attempted)) {
      // Running reached the attempted version → install succeeded. Clear the
      // record; the "Updated to Version ..." notice (Toast B, below) handles
      // the success surface.
      const next = { ...state, attemptedInstall: null, attemptedInstallSurfacedCount: 0 };
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
      // Running did NOT reach the attempted version → the install silently
      // failed.
      if (state.attemptedInstallSurfacedCount >= INSTALL_FAILURE_MAX_SURFACES) {
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
        };
        if (persistSafely(next, 'install-failed-giveup')) {
          state = next;
          logger.warn('attempted install exhausted its retry budget — clearing record', {
            attempted,
            running: currentVersion,
            surfaced: INSTALL_FAILURE_MAX_SURFACES,
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
          message: err instanceof Error ? err.message : String(err),
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

  if (updatesEnabled) {
    void updater
      .checkForUpdates()
      .then(() => {
        startPeriodicChecks();
      })
      .catch((err: unknown) => {
        logger.debug('first-launch checkForUpdates rejected', {
          message: err instanceof Error ? err.message : String(err),
        });
        // If the proxy feed caused it, revert to GitHub and re-check once.
        revertToGithubFeed('first-check-rejected');
        // Still start the timer — the next fire may succeed.
        startPeriodicChecks();
      });
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
    destroy(): void {
      if (timerHandle) {
        clock.clearTimeout(timerHandle);
        timerHandle = null;
      }
      if (relaunchInFlight) {
        clock.clearTimeout(relaunchInFlight.watchdog);
        relaunchInFlight = null;
      }
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
            message: err instanceof Error ? err.message : String(err),
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
            message: err instanceof Error ? err.message : String(err),
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
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return null;
  }
}
