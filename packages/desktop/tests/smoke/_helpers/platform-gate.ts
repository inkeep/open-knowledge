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
 * Three admission gates cover most specs, and the distinction is deliberate:
 *
 *   - CROSS-PLATFORM specs gate on {@link PLATFORM_SUPPORTED}. They run on
 *     every OS the harness can drive. A spec belongs here when nothing in it
 *     is macOS-specific.
 *   - PTY specs gate on {@link PTY_PLATFORM_SUPPORTED}. They run on macOS,
 *     Linux, and Windows; main separately hides the product below Windows'
 *     ConPTY build floor.
 *   - DARWIN-ONLY specs keep their local `DARWIN` constant. A spec belongs
 *     there when it drives a genuinely macOS-only surface: `open(1)` / Apple
 *     Event URL delivery or the darwin chrome stack (vibrancy / hiddenInset
 *     traffic lights).
 *
 * A gate can also EXCLUDE a platform rather than admit one — `test.skip(DARWIN,
 * …)` for a describe that only means anything off macOS, `test.skip(WINDOWS, …)`
 * for a POSIX-only mechanism. Those are not a fourth category so much as the
 * same constants read the other way round, and the roster below records them
 * verbatim so the direction is never in doubt.
 *
 * Prefer growing the cross-platform set over adding platform branches inside a
 * spec. Every gate each spec carries is recorded in
 * {@link SPEC_PLATFORM_GATES} below, so a move is a deliberate two-place edit
 * rather than a one-line skip swap.
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
export const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'win32', 'linux']);

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

/**
 * Every platform gate each smoke spec carries, in source order, as the exact
 * condition text of the `test.skip` / `test.fixme` call that expresses it.
 *
 * The categories above describe how to CHOOSE a gate; this roster records which
 * gates each file actually has. `platform-gate.test.ts` re-derives every entry
 * from that spec's own syntax tree and fails when a derived list stops matching,
 * so a spec cannot be widened onto new platforms as a silent side effect of a
 * change that never names it.
 *
 * It is the condition TEXT rather than a category name because the corpus gates
 * in more shapes than a category vocabulary can hold: `!DARWIN` (run only on
 * macOS) and `DARWIN` (run everywhere BUT macOS) are opposite constraints, and
 * `WINDOWS || TARGET.mode === 'packaged'` is neither. Pinning the text describes
 * all of them exactly and needs no vocabulary to grow when a new shape appears.
 *
 * It is the whole SEQUENCE because a spec may gate its describes separately, and
 * deleting one of them widens that block alone. The cost is that adding or
 * removing a gated describe also bumps the entry; that is the intended trade,
 * since a new gated block is itself a statement about where tests run.
 *
 * Editing an entry is the point: widen a spec only alongside a run of that spec,
 * green, on the platforms you are widening it to, and say where that run is in
 * the pull request. Narrowing an entry is cheap and needs no run.
 */
export const SPEC_PLATFORM_GATES = {
  '_nav-empty-840x600.e2e.ts': ['!PLATFORM_SUPPORTED'],
  '_nav-size-screenshots.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'agent-patch-divergence-probe.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'background-throttle.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'cold-single-file-launch.e2e.ts': ['!DARWIN'],
  'consent-dialog.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'create-new-project.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'deep-link.e2e.ts': ['!DARWIN'],
  'external-link.e2e.ts': ['!DARWIN'],
  'mcp-wiring.e2e.ts': ['!PLATFORM_SUPPORTED', 'WINDOWS', "WINDOWS || TARGET.mode === 'packaged'"],
  'navigator-close-on-open.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'navigator-return.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'note-window.e2e.ts': ['!PLATFORM_SUPPORTED', '!DARWIN'],
  'okf-rule-toggle.e2e.ts': ['!DARWIN'],
  'qa-create-new-extended.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'rename-divergence-probe.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'report-bug.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'saved-theme-paint.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'share-receive-miss-terminal.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'share-receive-multi-worktree.e2e.ts': ['!DARWIN'],
  'sidebar-create-rename-editable.e2e.ts': ['!DARWIN'],
  'sidebar-pill-lockstep-fade.e2e.ts': ['!DARWIN'],
  'skill-scope-roundtrip.e2e.ts': ['!DARWIN'],
  'skills-studio.e2e.ts': ['!DARWIN'],
  'terminal-dock-state.e2e.ts': ['!PTY_PLATFORM_SUPPORTED'],
  'terminal-dock.e2e.ts': ['!PTY_PLATFORM_SUPPORTED'],
  'terminal-links.e2e.ts': ['!PTY_PLATFORM_SUPPORTED'],
  'terminal-movement.e2e.ts': ['!PTY_PLATFORM_SUPPORTED'],
  'terminal-process-restart.e2e.ts': ['!PTY_PLATFORM_SUPPORTED'],
  'terminal-tabs.e2e.ts': ['!PTY_PLATFORM_SUPPORTED'],
  'terminal-window.e2e.ts': ['!PTY_PLATFORM_SUPPORTED'],
  'theme-sync.e2e.ts': ['!DARWIN'],
  'uninstall-ipc-bridge.e2e.ts': ['!DARWIN'],
  'uninstall-notice.e2e.ts': ['!DARWIN'],
  'uninstall-picker.e2e.ts': ['!DARWIN'],
  'uninstall-survey.e2e.ts': ['!DARWIN'],
  'uninstall-window-chrome.e2e.ts': ['!DARWIN'],
  'window-chrome.e2e.ts': ['!PLATFORM_SUPPORTED', 'DARWIN', '!PLATFORM_SUPPORTED'],
  'window-min-size.e2e.ts': ['!PLATFORM_SUPPORTED'],
} as const satisfies Record<string, readonly string[]>;
