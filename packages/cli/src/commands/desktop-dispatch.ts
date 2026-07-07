/**
 * `ok` (no args) → desktop-app dispatch helpers.
 *
 * Pure-function detection + launch for the macOS desktop Electron app
 * (`@inkeep/open-knowledge-desktop`). When the desktop is detected as
 * available + interactive, the CLI hands off to it via `open -b
 * com.inkeep.open-knowledge` (LaunchServices by bundle ID — fires Apple
 * Events, respects `requestSingleInstanceLock()`, preserves Gatekeeper
 * paths). Otherwise the dispatch returns false with a specific reason
 * and the caller falls through to the existing `ok start` flow.
 */

import type { spawn as NativeSpawn, SpawnOptions } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * macOS bundle identifier for the desktop app. Reused for protocol
 * handler registration and `open -b` LaunchServices dispatch — single
 * identity surface. Source of truth: packages/desktop/electron-builder.yml.
 */
export const DESKTOP_BUNDLE_ID = 'com.inkeep.open-knowledge';

const DESKTOP_BUNDLE_NAME = 'OpenKnowledge.app';

/** Standard install location probed first. */
const APPLICATIONS_BUNDLE_PATH = `/Applications/${DESKTOP_BUNDLE_NAME}`;

/** Reasons enum — stable strings; future modes extend, do not rename. */
type DetectReason =
  | 'available'
  | 'darwin-only'
  | 'force-browser'
  | 'no-bundle'
  | 'headless'
  | 'stat-error';

export interface DetectResult {
  readonly available: boolean;
  readonly reason: DetectReason;
  /**
   * Resolved `.app` bundle path when detection found one — used in error
   * messages. Always set when `available: true`; may be set when
   * `available: false` (e.g., headless gate fired but a bundle exists).
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
  try {
    const exec = join(bundlePath, 'Contents', 'MacOS', 'OpenKnowledge');
    const meta = deps.statSync(exec);
    if (!meta) return false;
    return typeof meta.isFile === 'function' ? meta.isFile() : false;
  } catch {
    return false;
  }
}

/**
 * Detection logic for `ok` (no args) dispatch. Pure function — feed
 * fakes for unit tests, real `process` values in production.
 *
 * Ordering:
 *   1. `OK_FORCE_BROWSER=1` → return false immediately.
 *   2. `platform !== 'darwin'` → return false ('darwin-only').
 *   3. Resolve bundle path (a/b/c). If no bundle → return false ('no-bundle').
 *   4. If `OK_FORCE_DESKTOP=1` → return true ('available') — SKIP headless gate.
 *   5. Headless gate: `isTTY !== true` OR `SSH_CONNECTION` OR `SSH_TTY`
 *      → return false ('headless').
 *   6. Else → return true ('available').
 */
export function detectDesktop(deps: DetectDeps): DetectResult {
  // Failsafe: OK_FORCE_BROWSER overrides everything else.
  if (deps.env.OK_FORCE_BROWSER === '1') {
    return { available: false, reason: 'force-browser' };
  }

  if (deps.platform !== 'darwin') {
    return { available: false, reason: 'darwin-only' };
  }

  let bundlePath: string | null;
  try {
    bundlePath = resolveBundlePath(deps);
  } catch {
    return { available: false, reason: 'stat-error' };
  }

  if (!bundlePath) {
    return { available: false, reason: 'no-bundle' };
  }

  // OK_FORCE_DESKTOP skips the headless gate but still requires the
  // bundle to exist (already verified above).
  if (deps.env.OK_FORCE_DESKTOP === '1') {
    return { available: true, reason: 'available', bundlePath };
  }

  if (deps.isTTY !== true || deps.env.SSH_CONNECTION || deps.env.SSH_TTY) {
    return { available: false, reason: 'headless', bundlePath };
  }

  return { available: true, reason: 'available', bundlePath };
}

interface LaunchDeps {
  readonly spawn: typeof NativeSpawn;
  /** Optional logger for the launch stderr line. Defaults to console.error. */
  readonly log?: (message: string) => void;
}

/**
 * Spawn the desktop app via LaunchServices by bundle ID.
 *
 * `open -b com.inkeep.open-knowledge` routes through LaunchServices,
 * fires Apple Events, respects `requestSingleInstanceLock()`, and
 * keeps Gatekeeper paths intact. The spawn is detached + stdio:'ignore'
 * + `unref()` so the CLI process can exit cleanly while the desktop
 * keeps running.
 */
export function launchDesktop(deps: LaunchDeps): void {
  const log = deps.log ?? ((m) => console.error(m));
  // Include escape-hatch hint inline so users surprised by the dispatch
  // (first time after installing the desktop) see immediately how to
  // override — Homebrew-style "what just happened, how to undo it".
  log(
    'Launching OpenKnowledge desktop (use `ok start` for the browser server, or `OK_FORCE_BROWSER=1` to always skip)',
  );
  // Scrub `ELECTRON_RUN_AS_NODE` from the spawned `open`'s env. The CLI
  // wrapper (`Contents/Resources/cli/bin/ok.sh`) sets it to 1 so the bundled
  // Electron binary acts as a Node host; LaunchServices propagates the
  // caller's env into the desktop process it spawns, and the desktop
  // Electron main process sees `ELECTRON_RUN_AS_NODE=1`, runs as a headless
  // Node host with no script, and exits immediately. Symptom: the
  // "Launching OpenKnowledge desktop" line prints but no GUI appears.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = deps.spawn('open', ['-b', DESKTOP_BUNDLE_ID], {
    detached: true,
    stdio: 'ignore',
    env,
  } satisfies SpawnOptions);
  child.unref();
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
      return `Desktop app not found at ${APPLICATIONS_BUNDLE_PATH}. Install via DMG, or omit --mode for browser mode.`;
    case 'darwin-only':
      return 'Desktop app is macOS-only on this release. Use --mode=browser, or omit --mode for the server fallback.';
    case 'headless':
      return 'Desktop launch is gated in headless contexts (CI, SSH, non-TTY stdout). Set OK_FORCE_DESKTOP=1 to override, or use --mode=browser.';
    case 'force-browser':
      return 'OK_FORCE_BROWSER=1 is set — desktop dispatch is disabled. Unset it to use --mode=app.';
    case 'stat-error':
      return `Failed to inspect desktop bundle at ${APPLICATIONS_BUNDLE_PATH} (filesystem error). Check permissions or use --mode=browser.`;
    case 'available':
      // Defensive — caller should not invoke notFoundMessage when available.
      return `Desktop app appears available at ${APPLICATIONS_BUNDLE_PATH} but launch dispatch did not fire (caller bug).`;
  }
}
