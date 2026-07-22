/**
 * `ok` (no args) → desktop-app dispatch helpers.
 *
 * Pure-function detection + launch for the desktop Electron app
 * (`@inkeep/open-knowledge-desktop`). When the desktop is detected as
 * available + interactive, the CLI hands off to it — on macOS via `open -b
 * com.inkeep.open-knowledge` (LaunchServices by bundle ID — fires Apple
 * Events, respects `requestSingleInstanceLock()`, preserves Gatekeeper
 * paths); on Windows/Linux by spawning the detected desktop executable
 * directly (`requestSingleInstanceLock()` folds a second spawn into the
 * running instance). Otherwise the dispatch returns false with a specific
 * reason and the caller falls through to the existing `ok start` flow.
 */

import type { spawn as NativeSpawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { spawnDetachedScrubbed } from '../utils/detached-spawn.ts';

/**
 * macOS bundle identifier for the desktop app. Reused for protocol
 * handler registration and `open -b` LaunchServices dispatch — single
 * identity surface. Source of truth: packages/desktop/electron-builder.yml.
 */
export const DESKTOP_BUNDLE_ID = 'com.inkeep.open-knowledge';

const DESKTOP_BUNDLE_NAME = 'OpenKnowledge.app';

/** Standard install location probed first. */
const APPLICATIONS_BUNDLE_PATH = `/Applications/${DESKTOP_BUNDLE_NAME}`;

/** Reasons enum — stable strings; future modes extend, do not rename.
 *  `darwin-only` is retired from emission (the desktop ships on win/linux
 *  too) but kept in the union — stable-string contract. */
type DetectReason =
  | 'available'
  | 'darwin-only'
  | 'unsupported-platform'
  | 'force-browser'
  | 'no-bundle'
  | 'headless'
  | 'stat-error';

export interface DetectResult {
  readonly available: boolean;
  readonly reason: DetectReason;
  /**
   * Resolved desktop install path when detection found one — the `.app`
   * bundle dir on macOS, the desktop executable path on Windows/Linux
   * (`launchDesktop` spawns it directly there). Always set when
   * `available: true`; may be set when `available: false` (e.g., headless
   * gate fired but an install exists).
   */
  readonly bundlePath?: string;
}

/**
 * Side-effect surface for `detectDesktop`. Injected so unit tests drive
 * the full matrix without a real macOS or real desktop install.
 */
export interface DetectDeps {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** Returns the realpath of the entry binary — `process.execPath`. */
  readonly execPath: string;
  /**
   * `process.stdout.isTTY` — undefined when stdout is a pipe/redirect.
   * We treat undefined as `false` (non-TTY).
   */
  readonly isTTY: boolean | undefined;
  /**
   * Sync stat of an absolute path. Returns metadata if accessible,
   * `null` if the path doesn't exist, throws only on unexpected errors.
   * Real impl: `fs.statSync(p, { throwIfNoEntry: false })`.
   */
  readonly statSync: (
    path: string,
  ) => { isFile?: () => boolean; isDirectory?: () => boolean } | null;
  /** Override — `homedir()` in production. */
  readonly homeDir?: string;
}

/**
 * Build a `DetectDeps` populated from the live `process` surface. Single
 * factory shared by both call sites (cli.ts no-args dispatch and
 * start.ts `--mode=app`) so probe semantics cannot drift between them.
 */
export function createRealDetectDeps(): DetectDeps {
  return {
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    isTTY: process.stdout.isTTY,
    statSync: (p) => {
      try {
        return statSync(p, { throwIfNoEntry: false }) ?? null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Resolve the desktop bundle path, or `null` if no source produced a
 * usable path. Used both as the detection signal and as input to error
 * messages.
 *
 * Probes (in order):
 *   (a) Bundled-CLI introspection — when `ELECTRON_RUN_AS_NODE === '1'`
 *       AND `execPath` matches `/.app/Contents/MacOS/`, walk up to the
 *       `.app` ancestor.
 *   (b) `/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge`
 *   (c) `~/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge`
 *
 * Note: We probe the executable file inside the bundle, not just the
 * `.app` directory — a directory named `OpenKnowledge.app` could exist
 * without a real bundle. Verifying the executable rules out false
 * positives.
 */
function resolveBundlePath(deps: DetectDeps): string | null {
  // (a) Bundled-CLI introspection — the CLI is the Electron runtime
  // itself, so the desktop bundle is its containing .app.
  if (deps.env.ELECTRON_RUN_AS_NODE === '1') {
    const m = /(.+?\.app)\/Contents\/MacOS\//.exec(deps.execPath);
    if (m?.[1]) {
      return m[1];
    }
  }

  // (b) /Applications/<bundle>
  if (probeBundle(deps, APPLICATIONS_BUNDLE_PATH)) {
    return APPLICATIONS_BUNDLE_PATH;
  }

  // (c) ~/Applications/<bundle>
  const home = deps.homeDir ?? homedir();
  const userBundlePath = join(home, 'Applications', DESKTOP_BUNDLE_NAME);
  if (probeBundle(deps, userBundlePath)) {
    return userBundlePath;
  }

  return null;
}

/**
 * Verify `<bundlePath>/Contents/MacOS/OpenKnowledge` exists. Returns
 * true on a real bundle, false otherwise. Stat errors are caught and
 * treated as "not present" — the dispatch path must never throw.
 */
function probeBundle(deps: DetectDeps, bundlePath: string): boolean {
  return probeExecutable(deps, join(bundlePath, 'Contents', 'MacOS', 'OpenKnowledge'));
}

/** True iff `path` stats as a real file. Never throws. */
function probeExecutable(deps: DetectDeps, path: string): boolean {
  try {
    const meta = deps.statSync(path);
    if (!meta) return false;
    return typeof meta.isFile === 'function' ? meta.isFile() : false;
  } catch {
    return false;
  }
}

/**
 * Windows probes (NSIS per-user one-click install):
 *   (a) Bundled-CLI introspection — the `ok.cmd`/`ok.ps1` wrappers run the
 *       desktop exe as a Node host, so `execPath` IS the desktop binary.
 *   (b) `%LOCALAPPDATA%\Programs\@inkeepopen-knowledge-desktop\OpenKnowledge.exe`
 *       — electron-builder's one-click per-user install dir is ALWAYS the
 *       sanitized package name (`getWindowsInstallationDirName` only tries
 *       productName for assisted/per-machine installs). VM-verified against
 *       a real NSIS install. The productName-shaped dir is probed second as
 *       a hedge against that upstream rule changing.
 */
const WIN_INSTALL_DIR_NAMES = ['@inkeepopen-knowledge-desktop', 'OpenKnowledge'] as const;

function resolveWindowsExecutable(deps: DetectDeps): string | null {
  if (deps.env.ELECTRON_RUN_AS_NODE === '1' && /\\OpenKnowledge\.exe$/i.test(deps.execPath)) {
    return deps.execPath;
  }
  const localAppData = deps.env.LOCALAPPDATA;
  if (localAppData) {
    for (const dirName of WIN_INSTALL_DIR_NAMES) {
      const exe = win32.join(localAppData, 'Programs', dirName, 'OpenKnowledge.exe');
      if (probeExecutable(deps, exe)) return exe;
    }
  }
  return null;
}

/**
 * Linux probes:
 *   (a) Bundled-CLI introspection — the linux `ok.sh` wrapper runs the
 *       desktop binary as a Node host, so `execPath` IS the desktop binary
 *       (deb layout AND a live AppImage mount both qualify: spawning the
 *       running mount's binary is valid for the mount's lifetime, and the
 *       single-instance lock folds it into the running app).
 *   (b) `/opt/OpenKnowledge/openknowledge` — the deb install path.
 * No probe exists for a non-running AppImage (no fixed location) — that
 * falls through to `no-bundle` and the browser-mode fallback.
 */
function resolveLinuxExecutable(deps: DetectDeps): string | null {
  if (deps.env.ELECTRON_RUN_AS_NODE === '1' && deps.execPath.endsWith('/openknowledge')) {
    return deps.execPath;
  }
  const debExe = '/opt/OpenKnowledge/openknowledge';
  if (probeExecutable(deps, debExe)) return debExe;
  return null;
}

/**
 * Detection logic for `ok` (no args) dispatch. Pure function — feed
 * fakes for unit tests, real `process` values in production.
 *
 * Ordering:
 *   1. `OK_FORCE_BROWSER=1` → return false immediately.
 *   2. Unknown platform → return false ('unsupported-platform').
 *   3. Resolve the per-platform install (see the resolver trio). If none
 *      → return false ('no-bundle').
 *   4. If `OK_FORCE_DESKTOP=1` → return true ('available') — SKIP headless gate.
 *   5. Headless gate: not tty-interactive OR `SSH_CONNECTION` OR `SSH_TTY`.
 *      tty-interactive = `isTTY === true`, plus the win32 carve-out:
 *      `isTTY === undefined` with no `CI` env (Electron-as-Node stdio are
 *      pipes on Windows, so undefined is the interactive-console signature
 *      there — see the inline comment)
 *      (plus no `DISPLAY`/`WAYLAND_DISPLAY` on Linux) → return false ('headless').
 *   6. Else → return true ('available').
 */
export function detectDesktop(deps: DetectDeps): DetectResult {
  // Failsafe: OK_FORCE_BROWSER overrides everything else.
  if (deps.env.OK_FORCE_BROWSER === '1') {
    return { available: false, reason: 'force-browser' };
  }

  if (deps.platform !== 'darwin' && deps.platform !== 'win32' && deps.platform !== 'linux') {
    return { available: false, reason: 'unsupported-platform' };
  }

  let bundlePath: string | null;
  try {
    bundlePath =
      deps.platform === 'darwin'
        ? resolveBundlePath(deps)
        : deps.platform === 'win32'
          ? resolveWindowsExecutable(deps)
          : resolveLinuxExecutable(deps);
  } catch {
    return { available: false, reason: 'stat-error' };
  }

  if (!bundlePath) {
    return { available: false, reason: 'no-bundle' };
  }

  // OK_FORCE_DESKTOP skips the headless gate but still requires the
  // install to exist (already verified above).
  if (deps.env.OK_FORCE_DESKTOP === '1') {
    return { available: true, reason: 'available', bundlePath };
  }

  // On Windows the wrappers run the CLI as Electron-as-Node, whose stdio
  // arrive as pipes even in a real interactive console — every isTTY is
  // undefined there, never true (VM-verified against a live install). An
  // undefined probe on win32 therefore means "console wrapper", not
  // "headless"; an explicit false still declines, and CI/SSH markers
  // override. OK_FORCE_BROWSER remains the universal escape hatch.
  const ttyInteractive =
    deps.isTTY === true || (deps.platform === 'win32' && deps.isTTY === undefined && !deps.env.CI);
  if (!ttyInteractive || deps.env.SSH_CONNECTION || deps.env.SSH_TTY) {
    return { available: false, reason: 'headless', bundlePath };
  }

  // A Linux session with no display server can't host a GUI window even
  // from an interactive TTY (pure console logins, containers).
  if (deps.platform === 'linux' && !deps.env.DISPLAY && !deps.env.WAYLAND_DISPLAY) {
    return { available: false, reason: 'headless', bundlePath };
  }

  return { available: true, reason: 'available', bundlePath };
}

interface LaunchDeps {
  readonly spawn: typeof NativeSpawn;
  /** Optional logger for the launch stderr line. Defaults to console.error. */
  readonly log?: (message: string) => void;
  /** Platform override for tests. Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Spawn the desktop app.
 *
 * macOS: `open -b com.inkeep.open-knowledge` routes through
 * LaunchServices, fires Apple Events, respects
 * `requestSingleInstanceLock()`, and keeps Gatekeeper paths intact.
 *
 * Windows/Linux: spawn the executable `detectDesktop` resolved
 * (`detection.bundlePath`) directly — there is no LaunchServices analog,
 * and the single-instance lock folds a second spawn into the running app.
 *
 * All platforms: detached + stdio:'ignore' + `unref()` so the CLI process
 * can exit cleanly while the desktop keeps running.
 */
export function launchDesktop(deps: LaunchDeps, detection?: DetectResult): void {
  const log = deps.log ?? ((m) => console.error(m));
  const platform = deps.platform ?? process.platform;
  // Include escape-hatch hint inline so users surprised by the dispatch
  // (first time after installing the desktop) see immediately how to
  // override — Homebrew-style "what just happened, how to undo it".
  log(
    'Launching OpenKnowledge desktop (use `ok start` for the browser server, or `OK_FORCE_BROWSER=1` to always skip)',
  );
  if (platform === 'darwin') {
    spawnDetachedScrubbed('open', ['-b', DESKTOP_BUNDLE_ID], { spawn: deps.spawn });
    return;
  }
  // Windows/Linux: no LaunchServices analog, so spawn the resolved desktop
  // executable directly. The shared helper scrubs `ELECTRON_RUN_AS_NODE` (the
  // CLI wrappers set it so the bundled Electron acts as a Node host — an
  // Electron GUI target that inherits it boots headless and exits) and hides
  // the Windows console.
  const target = detection?.bundlePath;
  if (!target) {
    // Callers only launch on `available: true`, which always carries
    // bundlePath — reaching here is a caller bug, not a user state.
    log('Desktop launch skipped: no resolved desktop executable (caller bug).');
    return;
  }
  spawnDetachedScrubbed(target, [], { spawn: deps.spawn });
}

/**
 * Render the error message for `ok start --mode=app` when detection
 * returns false. Different reasons surface different actionable messages
 * — "not found" is misleading when the bundle IS found but the headless
 * gate fired. Caller is responsible for printing + exiting; this just
 * builds the string so it's testable.
 */
export function notFoundMessage(reason: DetectReason = 'no-bundle'): string {
  switch (reason) {
    case 'no-bundle':
      return 'Desktop app not found (checked the standard install locations for this OS). Install it, or omit --mode for browser mode.';
    case 'darwin-only':
    case 'unsupported-platform':
      return 'Desktop app is not available on this platform. Use --mode=browser, or omit --mode for the server fallback.';
    case 'headless':
      return 'Desktop launch is gated in headless contexts (CI, SSH, non-TTY stdout). Set OK_FORCE_DESKTOP=1 to override, or use --mode=browser.';
    case 'force-browser':
      return 'OK_FORCE_BROWSER=1 is set — desktop dispatch is disabled. Unset it to use --mode=app.';
    case 'stat-error':
      return 'Failed to inspect the desktop install (filesystem error). Check permissions or use --mode=browser.';
    case 'available':
      // Defensive — caller should not invoke notFoundMessage when available.
      return 'Desktop app appears available but launch dispatch did not fire (caller bug).';
  }
}
