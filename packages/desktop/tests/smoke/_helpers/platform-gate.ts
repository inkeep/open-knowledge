/**
 * Platform gating + home-directory redirection for the desktop smoke suite.
 *
 * The suite started darwin-only ("Smoke harness is darwin-only in v0"), and
 * every spec carried its own `const DARWIN = process.platform === 'darwin'`
 * skip. That blanket gate outlived its reason: the Windows/Linux window chrome
 * shipped (`src/main/window-chrome.ts` — `titleBarStyle: 'hidden'` +
 * `titleBarOverlay`), and most specs never touched a macOS-only surface in the
 * first place — they launch Electron, poke the renderer, and read main-process
 * state.
 *
 * Three categories now exist, and the distinction is deliberate:
 *
 *   - CROSS-PLATFORM specs gate on {@link PLATFORM_SUPPORTED}. They run on
 *     every OS the harness can drive. A spec belongs here when nothing in it
 *     is macOS-specific.
 *   - PTY specs gate on {@link PTY_PLATFORM_SUPPORTED}. The terminal ships on
 *     macOS and Linux; Windows remains outside this capability until its
 *     ConPTY implementation lands.
 *   - DARWIN-ONLY specs keep their local `DARWIN` constant. A spec belongs
 *     there when it drives a genuinely macOS-only surface: `open(1)` / Apple
 *     Event URL delivery or the darwin chrome stack (vibrancy / hiddenInset
 *     traffic lights).
 *
 * Moving a spec between categories is a one-line change; prefer growing the
 * cross-platform set over adding platform branches inside a spec.
 */

import { join } from 'node:path';
import { isTerminalPlatform } from '../../../src/shared/terminal-platform.ts';

/** Opt-in gate shared by every smoke spec. */
export const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';

/**
 * Platforms the smoke harness can drive. Electron itself ships for all three;
 * this set exists so an exotic host (freebsd, aix) skips with a clear reason
 * instead of failing deep inside a launch.
 */
const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'win32', 'linux']);

/** True on every platform a cross-platform spec is expected to pass on. */
export const PLATFORM_SUPPORTED = SUPPORTED_PLATFORMS.has(process.platform);

export const PLATFORM_SKIP_REASON = `Smoke harness does not support platform "${process.platform}".`;

/** True on every platform that ships the desktop PTY capability. */
export const PTY_PLATFORM_SUPPORTED = isTerminalPlatform(process.platform);

export const PTY_PLATFORM_SKIP_REASON = `Desktop terminal does not support platform "${process.platform}".`;

/**
 * Environment overrides that actually redirect the app's home directory on
 * every OS.
 *
 * `HOME` alone is a macOS/Linux answer. On Windows, Node's `os.homedir()` — and
 * therefore Electron's `app.getPath('home')` and every `~/.ok/...` path the
 * server derives from it — reads `USERPROFILE`, ignoring `HOME` entirely. A
 * spec that sets only `HOME` silently writes into the real profile of whoever
 * (or whatever CI account) runs it, which both pollutes the host and makes the
 * test depend on leftover state from previous runs.
 *
 * Chromium's own directories are NOT redirected here: specs pass
 * `--user-data-dir` explicitly, and repointing `APPDATA` / `LOCALAPPDATA` at a
 * fresh empty tree breaks Electron startup on Windows.
 */
export function homeEnv(tmpHome: string): Record<string, string> {
  if (process.platform !== 'win32') return { HOME: tmpHome };
  // `USERPROFILE` is what Node reads first on Windows; `HOME` is kept for the
  // POSIX-shaped tooling the app shells out to (git, and anything reading
  // `$HOME` from a bash-ish environment).
  return { HOME: tmpHome, USERPROFILE: tmpHome };
}

/**
 * Canonical per-test user-data directory under a seeded tmp home. Kept here
 * (rather than duplicated per spec) so the cross-platform specs agree on one
 * layout.
 */
export function userDataDirFor(tmpHome: string): string {
  return join(tmpHome, 'electron-userdata');
}
