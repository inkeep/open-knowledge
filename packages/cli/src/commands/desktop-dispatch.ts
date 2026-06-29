
import type { spawn as NativeSpawn, SpawnOptions } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DESKTOP_BUNDLE_ID = 'com.inkeep.open-knowledge';

const DESKTOP_BUNDLE_NAME = 'OpenKnowledge.app';

const APPLICATIONS_BUNDLE_PATH = `/Applications/${DESKTOP_BUNDLE_NAME}`;

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
  readonly bundlePath?: string;
}

export interface DetectDeps {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly execPath: string;
  readonly isTTY: boolean | undefined;
  readonly statSync: (
    path: string,
  ) => { isFile?: () => boolean; isDirectory?: () => boolean } | null;
  readonly homeDir?: string;
}

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
  if (deps.env.ELECTRON_RUN_AS_NODE === '1') {
    const m = /(.+?\.app)\/Contents\/MacOS\//.exec(deps.execPath);
    if (m?.[1]) {
      return m[1];
    }
  }

  if (probeBundle(deps, APPLICATIONS_BUNDLE_PATH)) {
    return APPLICATIONS_BUNDLE_PATH;
  }

  const home = deps.homeDir ?? homedir();
  const userBundlePath = join(home, 'Applications', DESKTOP_BUNDLE_NAME);
  if (probeBundle(deps, userBundlePath)) {
    return userBundlePath;
  }

  return null;
}

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

export function detectDesktop(deps: DetectDeps): DetectResult {
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
  readonly log?: (message: string) => void;
}

export function launchDesktop(deps: LaunchDeps): void {
  const log = deps.log ?? ((m) => console.error(m));
  log(
    'Launching OpenKnowledge desktop (use `ok start` for the browser server, or `OK_FORCE_BROWSER=1` to always skip)',
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = deps.spawn('open', ['-b', DESKTOP_BUNDLE_ID], {
    detached: true,
    stdio: 'ignore',
    env,
  } satisfies SpawnOptions);
  child.unref();
}

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
      return `Desktop app appears available at ${APPLICATIONS_BUNDLE_PATH} but launch dispatch did not fire (caller bug).`;
  }
}
