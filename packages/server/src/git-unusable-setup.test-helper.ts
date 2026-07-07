/**
 * Shared test harness for the "git-preflight at the project-setup boundary"
 * regression (inkeep/open-knowledge#356).
 *
 * Reproduces the reporter's macOS Apple-Silicon state, where the host `git`
 * exists and is executable but every invocation exits non-zero (the
 * `xcrun`/`libxcrun` arm64-vs-arm64e loader mismatch) — the "present-but-broken"
 * failure mode, distinct from "git absent" (ENOENT). The broken `git` stub is
 * written to a tmpdir at runtime (the same inline-fake-git technique
 * `project-git.test.ts` already uses) so the committed test carries no binary
 * fixture and runs identically in CI.
 *
 * Two environments are provided because this host (and CI) HAS a working git at
 * a `detectGit()` fallback path, so PATH-narrowing alone does NOT make git
 * unusable — it produces the check/use *binding divergence* the bug report
 * hinges on:
 *
 *   - `withBrokenBareGitOnly`  — bare `git` (PATH) is broken, but an absolute
 *     fallback git still works. `detectGit()` returns `source:'fallback'` (PASS)
 *     while a bare-`git` setup op fails. The binding-divergence env.
 *
 *   - `withUnusableGitEverywhere` — bare `git` broken AND no fallback git is
 *     reachable, so `detectGit()` itself throws `GitNotAvailableError`. The only
 *     state where the recoverable typed error is the unambiguous correct outcome
 *     for *every* valid fix shape (validate-the-bare-binding OR
 *     invoke-the-resolved-path).
 *
 * Fallbacks are neutralized by overriding `process.platform` to one whose
 * absolute fallback-path list (`fallbackPaths()` in `git-preflight.ts`) does not
 * exist on this host — NOT to assert any Windows behavior, but to deterministically
 * simulate "no git installed at any known-good location," which is the reporter's
 * actual broken-toolchain Mac. The override is restored before the harness
 * returns; `node:path` binds its platform at module load, so posix path handling
 * inside the setup op is unaffected (verified: the op still resolves
 * `/var/folders/...` tmpdirs correctly under the override).
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Faithful reproduction of the reporter's stderr — present-but-broken git. */
const BROKEN_GIT_STDERR =
  "xcrun: error: unable to load libxcrun (dlopen(/Applications/Xcode.app/Contents/Developer/usr/lib/libxcrun.dylib, 0x0005): tried: '/Applications/Xcode.app/Contents/Developer/usr/lib/libxcrun.dylib' (mach-o file, but is an incompatible architecture (have 'arm64', need 'arm64e')), '/System/Volumes/Preboot/Cryptexes/OS/Applications/Xcode.app/Contents/Developer/usr/lib/libxcrun.dylib' (no such file)).";

/**
 * Create a tmpdir containing a present-but-broken `git` stub: it exists and is
 * executable, but every subcommand (`--version`, `init`, `rev-parse`, `clone`,
 * ...) exits 1 with the xcrun loader error on stderr. Returns the dir; caller
 * removes it (see `withBrokenGitDir`).
 *
 * Module-internal: consumed only by `withBrokenGitDir` below. Not exported —
 * the two env wrappers are the harness's surface (an unused export trips knip).
 */
function makeBrokenGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok356-brokengit-'));
  const gitPath = join(dir, 'git');
  writeFileSync(
    gitPath,
    `#!/bin/sh\n# Present-but-broken git stub — catch-all: every subcommand fails identically.\necho ${JSON.stringify(BROKEN_GIT_STDERR)} >&2\nexit 1\n`,
    'utf-8',
  );
  chmodSync(gitPath, 0o755);
  return dir;
}

async function withBrokenGitDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = makeBrokenGitDir();
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

/**
 * Run `fn` with bare `git` resolving to a present-but-broken stub, while an
 * absolute fallback git on the host stays reachable. Models the binding
 * divergence: `detectGit()` PASSES via the fallback, but a bare-`git` op fails.
 */
export async function withBrokenBareGitOnly(fn: () => Promise<void>): Promise<void> {
  await withBrokenGitDir(async (dir) => {
    const origPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      await fn();
    } finally {
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
    }
  });
}

/**
 * Run `fn` with git unusable everywhere `detectGit()` looks: bare `git` (PATH)
 * is the broken stub, and the platform-specific absolute fallback paths do not
 * exist on this host. In this state `detectGit()` throws `GitNotAvailableError`,
 * so the recoverable typed error is the only correct outcome for any valid fix.
 */
export async function withUnusableGitEverywhere(fn: () => Promise<void>): Promise<void> {
  await withBrokenGitDir(async (dir) => {
    const origPath = process.env.PATH;
    const origPlatform = process.platform;
    process.env.PATH = dir;
    // Pick a platform whose fallback-path list is absent on this host. macOS/Linux
    // hosts → 'win32' (C:\... paths); a Windows host → 'linux' (/usr/bin/... paths).
    setPlatform(origPlatform === 'win32' ? 'linux' : 'win32');
    try {
      await fn();
    } finally {
      setPlatform(origPlatform);
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
    }
  });
}

/**
 * True when `value` carries a recoverable git-preflight signal — either typed
 * preflight error (`GitNotAvailableError` / code `GIT_NOT_AVAILABLE`, or
 * `GitTooOldError` / code `GIT_TOO_OLD`) or their platform-stable install-
 * guidance messages. Accepts an Error, a thrown value, or a raw event message
 * string. Deliberately duck-typed so the fix may surface the signal as the typed
 * error directly, a re-wrapped error preserving the code, or an error-event
 * message — without this classifier pinning one shape.
 */
export function isRecoverableGitSignal(value: unknown): boolean {
  if (value == null) return false;
  const code = (value as { code?: unknown }).code;
  if (code === 'GIT_NOT_AVAILABLE' || code === 'GIT_TOO_OLD') return true;
  const name = (value as { name?: unknown }).name;
  if (name === 'GitNotAvailableError' || name === 'GitTooOldError') return true;
  const msg = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  return (
    msg.includes('GIT_NOT_AVAILABLE') ||
    msg.includes('GIT_TOO_OLD') ||
    msg.includes('OpenKnowledge needs Git') ||
    msg.includes('OpenKnowledge requires Git') ||
    msg.includes('ok diagnose health')
  );
}
