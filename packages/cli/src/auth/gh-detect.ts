import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface GhDetectResult {
  available: boolean;
  token?: string;
}

export type ExecFileSyncFn = typeof execFileSync;
type FileExistsFn = (path: string) => boolean;

/**
 * Standard install locations for `gh` on macOS + Linux. Checked when the bare
 * `gh` lookup via `PATH` fails — which happens whenever OpenKnowledge runs
 * from a context that doesn't inherit the user's shell PATH. The macOS GUI
 * launch path (`launchd` → Electron → utility fork → spawned CLI) is the
 * load-bearing case: `launchd` provides only `/usr/bin:/bin:/usr/sbin:/sbin`,
 * so Homebrew-installed binaries at `/opt/homebrew/bin` are invisible.
 */
const KNOWN_GH_PATHS: readonly string[] = [
  '/opt/homebrew/bin/gh', // macOS Apple Silicon Homebrew
  '/usr/local/bin/gh', // macOS Intel Homebrew / manual install
  '/opt/local/bin/gh', // macOS MacPorts
  '/snap/bin/gh', // Linux snap
  '/usr/bin/gh', // Linux distro packages
];

const GH_AUTH_TOKEN_OPTIONS: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 5000,
  windowsHide: true,
};

interface DetectGhOptions {
  /** Injectable for tests. */
  _exec?: ExecFileSyncFn;
  /** Injectable for tests. */
  _fileExists?: FileExistsFn;
}

/**
 * Detect whether `gh` CLI is on PATH (or a known absolute install path) and
 * currently authenticated. Returns the token from `gh auth token` on success.
 *
 * When `host` is provided, scopes the lookup with `--hostname <host>` so a
 * GHES-only login isn't mistaken for github.com auth (or vice versa). Note
 * the flag spelling — `gh auth token` rejects `--host` with "unknown flag";
 * the canonical name is `--hostname` (alias `-h`).
 *
 * Lookup order: bare `gh` via `PATH` first (fast path for shell launches),
 * then `KNOWN_GH_PATHS` in order (only paths that exist on disk are tried).
 * Stops at the first command that returns a non-empty token.
 */
export function detectGh(host?: string, options: DetectGhOptions = {}): GhDetectResult {
  const exec = options._exec ?? execFileSync;
  const fileExists = options._fileExists ?? existsSync;
  const args = ['auth', 'token', ...(host ? ['--hostname', host] : [])];
  const candidates: string[] = ['gh', ...KNOWN_GH_PATHS.filter(fileExists)];

  for (const cmd of candidates) {
    try {
      const token = exec(cmd, args, GH_AUTH_TOKEN_OPTIONS).toString().trim();
      if (token.length > 0) return { available: true, token };
    } catch {
      // Try next candidate
    }
  }
  return { available: false };
}
