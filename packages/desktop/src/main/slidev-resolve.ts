/**
 * Detect a runnable `slidev` for a project without downloading anything.
 *
 * Resolution follows npm-exec semantics: a project's own
 * `node_modules/.bin/slidev` wins over a globally-installed one, so a deck can
 * pin the Slidev it renders under. The global fallback probes the user's
 * login-shell PATH — a GUI-launched Electron process does not inherit it, so a
 * globally-installed `slidev` is invisible to `process.env.PATH`. There is no
 * managed/download path here: an unresolved binary reports `available: false`
 * and the renderer hides the affordance.
 *
 * Electron-free and dependency-injected (the fs + login-shell probes are passed
 * in) so the resolution logic unit-tests without a real filesystem or a spawned
 * shell; `main/index.ts` wires the real probes.
 */
import { access, constants, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SlidevSource } from '../shared/ipc-channels.ts';

/** Whether a runnable `slidev` resolved and from where. The resolved path is
 *  intentionally not surfaced — callers that only need the yes/no + source
 *  never handle a raw filesystem path (which would also leak across the IPC
 *  boundary as unbounded-cardinality data). */
type SlidevResolution = { available: true; source: SlidevSource } | { available: false };

/** Boundary probes, injected so resolution logic is testable without touching
 *  the real filesystem or spawning a login shell. */
export interface SlidevResolveProbes {
  /** True iff an executable file exists at `absPath`. */
  isExecutableFile: (absPath: string) => Promise<boolean>;
  /** True iff `bin` resolves on the user's login-shell PATH. */
  isOnLoginPath: (bin: string) => Promise<boolean>;
}

/**
 * The project-local shim npm wrote for this platform.
 *
 * On Windows npm writes THREE files into `.bin`: an extension-less POSIX shell
 * script (for Git Bash), plus `slidev.cmd` and `slidev.ps1`. Only the `.cmd` is
 * runnable by `CreateProcess` — spawning the extension-less one fails, and it
 * would still be picked up by an existence check because Windows has no execute
 * bit. Detect and spawn MUST agree on this name or the "detected ⇒ launchable"
 * invariant breaks, which is why both sides call this.
 */
export function projectLocalSlidevBin(projectRoot: string, platform: NodeJS.Platform): string {
  return join(projectRoot, 'node_modules', '.bin', platform === 'win32' ? 'slidev.cmd' : 'slidev');
}

export async function resolveSlidev(
  projectRoot: string | undefined,
  probes: SlidevResolveProbes,
  platform: NodeJS.Platform = process.platform,
): Promise<SlidevResolution> {
  if (projectRoot) {
    const local = projectLocalSlidevBin(projectRoot, platform);
    if (await probes.isExecutableFile(local)) {
      return { available: true, source: 'project-local' };
    }
  }
  if (await probes.isOnLoginPath('slidev')) {
    return { available: true, source: 'global' };
  }
  return { available: false };
}

/**
 * Real filesystem executability check — `stat().isFile()` then `X_OK`. Absent,
 * inaccessible, broken-symlink, and not-a-file all collapse to `false`; Windows
 * has no execute bit, so a present regular file is treated as runnable there.
 * The catch is the fs API's own contract (it throws ENOENT/EACCES for the exact
 * absent/unreadable cases this returns `false` for), not a swallowed bug.
 */
export async function realIsExecutableFile(absPath: string): Promise<boolean> {
  try {
    const st = await stat(absPath);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    await access(absPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
