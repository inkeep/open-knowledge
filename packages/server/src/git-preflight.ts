/**
 * `git-preflight.ts` — single source of truth for "is git available and usable for OK."
 *
 * Wired into:
 *   - `bootServer()` in `boot.ts` (CLI auto-notice)
 *   - Electron main process `git-preflight-handler.ts` (UI auto-notice)
 *   - `ok diagnose health` subcommand (structured diagnose)
 *
 * Cross-platform from day one: macOS, Windows, Linux all produce typed errors
 * with platform-correct install guidance. Per-platform behavior is data (fallback
 * path lists, distro family table), not branched code paths.
 *
 * Two-stage probe:
 *   Stage 1 — `git --version` with the current process PATH.
 *   Stage 2 — iterate well-known absolute paths per platform, covering the
 *             documented Cursor-class "installed but invisible" failure mode
 *             where Spotlight/Dock-launched processes inherit launchctl's
 *             minimal default PATH.
 *
 * Distinct from `error-classification.ts`: that module classifies POST-execution
 * sync errors (network / auth / semantic / structural / local) as a
 * discriminated union. This module's `GitNotAvailableError` and `GitTooOldError`
 * are PRE-boot typed errors that throw at three fixed call sites and are caught
 * via `instanceof`. The two are scope-separated by design.
 */

import { type SpawnSyncOptions, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter as PATH_DELIM } from 'node:path';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';

/**
 * Minimum git version OK requires.
 *
 * Provisional value pending empirical validation by the tech-probe matrix at
 * `.github/workflows/git-version-matrix.yml`. The matrix runs on
 * `workflow_dispatch` across 12 cells (4 git versions × 3 OSes); the operator
 * handoff is to (a) trigger the workflow once, (b) read the matrix-summary
 * artifact, and (c) update this constant to the lowest version that passes
 * across all three platforms (or Linux+macOS if Windows is install-failed).
 *
 * Until then, the value stays at the conservative ceiling: OK uses
 * `git init --initial-branch=main` (introduced 2.28) and a handful of
 * plumbing options that exist back to 2.20. lefthook pins 2.31 as its floor;
 * we start there as conservative margin.
 */
export const MIN_GIT_VERSION = '2.31.0';

/**
 * Hard timeout for `spawnSync` probes (`git --version`, `command -v`, `where`).
 * Long enough for slow disks / cold caches; short enough that pathological
 * environments (stale NFS, network-mounted PATH entries) fail loudly rather
 * than hanging the entire boot sequence.
 */
const PROBE_TIMEOUT_MS = 5000;

// ---------- Result + error types ----------

export interface GitDetected {
  readonly ok: true;
  /** Detected `git --version` string, e.g. `"2.43.0"` */
  readonly version: string;
  /** Absolute path actually invoked. Invaluable for debugging
   *  "installed but not detected" reports. */
  readonly resolvedPath: string;
  /** Whether we found git via the inherited PATH or via a fallback path. */
  readonly source: 'PATH' | 'fallback';
}

export interface InstallOption {
  /** Human description, e.g. `"Install with Homebrew (no admin needed)"`. */
  readonly label: string;
  /** Shell command the user can copy-paste, or a directive to open a URL. */
  readonly command: string;
  /** UI framing hint — `true` for commands that prompt for admin/sudo. */
  readonly requiresAdmin: boolean;
}

export interface InstallGuidance {
  /** Product display name, e.g. `"Git"` or `"Git for Windows"`. */
  readonly product: string;
  /** Ranked install options — most-preferred first. */
  readonly options: readonly InstallOption[];
  /** Landing page if the user prefers manual download. */
  readonly url: string;
}

export class GitNotAvailableError extends Error {
  readonly code = 'GIT_NOT_AVAILABLE';
  readonly platform: NodeJS.Platform;
  readonly guidance: InstallGuidance;

  constructor(platform: NodeJS.Platform, guidance: InstallGuidance, options?: { cause?: unknown }) {
    super(buildMissingMessage(guidance), options);
    this.name = 'GitNotAvailableError';
    this.platform = platform;
    this.guidance = guidance;
  }
}

export class GitTooOldError extends Error {
  readonly code = 'GIT_TOO_OLD';
  readonly platform: NodeJS.Platform;
  readonly detected: string;
  readonly required: string;
  readonly resolvedPath: string;
  readonly guidance: InstallGuidance;

  constructor(
    platform: NodeJS.Platform,
    detected: string,
    required: string,
    resolvedPath: string,
    guidance: InstallGuidance,
    options?: { cause?: unknown },
  ) {
    super(buildTooOldMessage(detected, required, resolvedPath, guidance), options);
    this.name = 'GitTooOldError';
    this.platform = platform;
    this.detected = detected;
    this.required = required;
    this.resolvedPath = resolvedPath;
    this.guidance = guidance;
  }
}

// ---------- Detection primitive ----------

/**
 * Detect whether a usable git binary exists.
 *
 * Two-stage probe:
 *   1. `git --version` with the inherited PATH.
 *   2. Iterate platform-specific fallback paths (handles GUI-launched apps
 *      that inherit a minimal PATH from launchctl / un-refreshed Windows shell).
 *
 * @throws GitNotAvailableError when both stages fail.
 */
export function detectGit(): GitDetected {
  // Stage 1 — inherited PATH.
  const stage1 = probeGit('git');
  if (stage1.kind === 'ok') {
    return {
      ok: true,
      version: stage1.version,
      resolvedPath: stage1.resolvedPath,
      source: 'PATH',
    };
  }

  // Stage 2 — platform-specific fallback paths.
  for (const candidate of fallbackPaths(process.platform)) {
    if (!existsSync(candidate)) continue;
    const result = probeGit(candidate);
    if (result.kind === 'ok') {
      return {
        ok: true,
        version: result.version,
        resolvedPath: candidate,
        source: 'fallback',
      };
    }
  }

  throw new GitNotAvailableError(process.platform, buildGuidance(process.platform));
}

/**
 * Detect git AND assert version is at least `MIN_GIT_VERSION`.
 *
 * @throws GitNotAvailableError when git is missing.
 * @throws GitTooOldError when detected version is below `MIN_GIT_VERSION`.
 */
export function assertGitAvailable(): GitDetected {
  const detected = detectGit();
  if (compareSemver(detected.version, MIN_GIT_VERSION) < 0) {
    throw new GitTooOldError(
      process.platform,
      detected.version,
      MIN_GIT_VERSION,
      detected.resolvedPath,
      buildGuidance(process.platform),
    );
  }
  return detected;
}

// ---------- Internal: probe + parse ----------

type ProbeResult =
  | { kind: 'ok'; version: string; resolvedPath: string }
  | { kind: 'fail'; reason: 'enoent' | 'unparseable' | 'timeout' | 'nonzero' };

/**
 * Invoke `<command> --version` with locale-stable env and a 5-second timeout.
 *
 * `LANG=C`/`LC_ALL=C` matches the convention in `git-handle.ts` and keeps
 * stderr text in stable English (important if downstream regex inspects it).
 */
function probeGit(command: string): ProbeResult {
  const opts: SpawnSyncOptions = withHiddenWindowsConsole({
    encoding: 'utf-8',
    timeout: PROBE_TIMEOUT_MS,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });
  const result = spawnSync(command, ['--version'], opts);
  if (result.error) {
    // `spawnSync` sets `signal` to `'SIGTERM'` on timeout.
    if ('signal' in result && result.signal === 'SIGTERM')
      return { kind: 'fail', reason: 'timeout' };
    return { kind: 'fail', reason: 'enoent' };
  }
  if (result.status !== 0) {
    return { kind: 'fail', reason: 'nonzero' };
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const version = parseGitVersion(stdout);
  if (version === null) return { kind: 'fail', reason: 'unparseable' };
  const resolvedPath = command === 'git' ? (resolveOnPath('git') ?? command) : command;
  return { kind: 'ok', version, resolvedPath };
}

/**
 * Parse `git --version` output.
 *
 * Handles known variants:
 *   - Linux / generic: `git version 2.39.3`
 *   - Apple Git: `git version 2.39.3 (Apple Git-145)`
 *   - Git for Windows: `git version 2.45.0.windows.1`
 *   - MinGit: `git version 2.45.0.1.windows.1`
 *
 * Returns the first `MAJOR.MINOR.PATCH` triple; vendor suffixes are dropped.
 */
export function parseGitVersion(stdout: string): string | null {
  const match = stdout.match(/git version (\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/**
 * Resolve a command name to an absolute path using the OS-native lookup tool.
 *
 * macOS / Linux: `command -v` via `/bin/sh -c` (POSIX builtin; more reliable
 * than the optional `which` binary).
 * Windows: `where`.
 *
 * Returns `null` if the lookup tool exits non-zero or its stdout is empty.
 *
 * The `name` argument is validated against `SAFE_COMMAND_NAME_RE` before the
 * POSIX branch interpolates it into the `/bin/sh -c "command -v ..."`
 * pipeline. Every current caller passes a hardcoded literal (`'git'`,
 * `'brew'`, `'winget'`, `'scoop'`, `'choco'`), so the input is already
 * safe — but the function is exported and accepts `string`, so a future
 * caller passing an env var or user input would otherwise create an OS
 * command injection vector. Rejecting non-conforming names with `null`
 * keeps the asymmetry with the Windows branch (which uses argv-array form
 * and isn't shell-bound) from drifting into a latent footgun.
 */
const SAFE_COMMAND_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

/**
 * Process-lifetime memo for positive `resolveOnPath` results, keyed by
 * command name. Successful lookups (absolute path returned) are cached so
 * repeated probes for the same name (notably `'git'`, fired by every
 * Stage-1 `probeGit('git')` call for diagnostic `resolvedPath` enrichment)
 * skip the `spawnSync` to the shell builtin / `where`. On pathological PATH
 * entries (stale NFS, slow network mounts) that adds non-trivial latency
 * per call.
 *
 * Null results are NOT cached: a package manager (`brew`, `winget`, etc.)
 * that wasn't installed at first probe may have been installed by the user
 * during the same process lifetime — re-probe each time so install guidance
 * stays current.
 *
 * Process-lifetime is the right TTL: paths don't legitimately move
 * mid-process under normal operation, and the worst-case staleness window
 * matches the boot lifetime of a single `ok start` / Electron utility
 * invocation.
 */
const resolveOnPathCache = new Map<string, string>();

/**
 * Reset the `resolveOnPath` positive-result cache. Test-only — production
 * callers never need this since the cache is keyed on command name and a
 * stable resolution is what callers want. Tests that need to assert
 * spawn-level behavior (e.g. the spawn matrix probe) call this between
 * cases so the second case's spawn actually fires rather than returning a
 * cached value from the first.
 */
export function __resetResolveOnPathCacheForTests(): void {
  resolveOnPathCache.clear();
}

/**
 * Seed the `resolveOnPath` positive-result cache. Test-only — lets a test pin
 * the absolute path a command name resolves to, independent of the host PATH.
 *
 * Needed because the cache's underlying lookup (`spawnSync('/bin/sh', …)` with
 * no `env`) resolves against the runtime's startup PATH snapshot, NOT a
 * `process.env.PATH` a test mutated mid-process (observed on Bun) — so PATH
 * narrowing alone cannot force resolution to a stub binary. Seeding does.
 * Production callers never need this; the cache is keyed on command name and a
 * stable resolution is exactly what they want.
 */
export function __seedResolveOnPathCacheForTests(name: string, resolvedPath: string): void {
  resolveOnPathCache.set(name, resolvedPath);
}

export function resolveOnPath(name: string): string | null {
  if (!SAFE_COMMAND_NAME_RE.test(name)) return null;
  const cached = resolveOnPathCache.get(name);
  if (cached !== undefined) return cached;
  // `timeout` bounds the worst case for pathological PATH entries (stale NFS
  // mount, slow network filesystem) that would otherwise hang the boot
  // sequence indefinitely — the failure-path callers (`buildGuidance`,
  // `hasBrew` / `hasWinget` / `hasScoop` / `hasChoco`) run while the user
  // already can't reach git, and a hung probe here means they never see
  // install guidance.
  let resolved: string | null;
  if (process.platform === 'win32') {
    const result = spawnSync(
      'where',
      [name],
      withHiddenWindowsConsole({ encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS }),
    );
    if (result.status !== 0) {
      resolved = null;
    } else {
      const first = (typeof result.stdout === 'string' ? result.stdout : '')
        .trim()
        .split(/\r?\n/)[0];
      resolved = first || null;
    }
  } else {
    // POSIX: `command -v` is a shell builtin, not a binary on disk.
    const result = spawnSync(
      '/bin/sh',
      ['-c', `command -v ${name}`],
      withHiddenWindowsConsole({
        encoding: 'utf-8',
        timeout: PROBE_TIMEOUT_MS,
      }),
    );
    if (result.status !== 0) {
      resolved = null;
    } else {
      const first = (typeof result.stdout === 'string' ? result.stdout : '')
        .trim()
        .split(/\r?\n/)[0];
      resolved = first || null;
    }
  }
  if (resolved !== null) {
    resolveOnPathCache.set(name, resolved);
  }
  return resolved;
}

/**
 * Platform-specific fallback paths probed when Stage 1 fails.
 *
 * Lists are ordered by likelihood of finding a *newer* git first
 * (Homebrew before CLT on macOS, Program Files before scoop on Windows).
 *
 * @internal — exported for test reuse.
 */
export function fallbackPaths(platform: NodeJS.Platform): readonly string[] {
  switch (platform) {
    case 'darwin':
      return [
        '/opt/homebrew/bin/git', // Apple Silicon brew
        '/usr/local/bin/git', // Intel brew + manual installs
        '/Library/Developer/CommandLineTools/usr/bin/git', // CLT
        '/usr/bin/git', // Apple-shipped stub
      ];
    case 'win32':
      return [
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
        join(homedir(), 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe'),
      ];
    default:
      return [
        '/usr/bin/git',
        '/usr/local/bin/git',
        join(homedir(), '.local', 'bin', 'git'),
        '/snap/bin/git',
      ];
  }
}

// ---------- Internal: install guidance ----------

/**
 * Compose ranked install guidance for the given platform.
 *
 * Filters the option list by which package managers are actually installed
 * (probed via `hasBrew` / `hasWinget` / etc.) so the user never sees a
 * suggestion they can't act on without a prerequisite install.
 *
 * @internal — exported for test reuse.
 */
export function buildGuidance(platform: NodeJS.Platform): InstallGuidance {
  switch (platform) {
    case 'darwin': {
      const options: InstallOption[] = [];
      if (hasBrew()) {
        options.push({
          label: 'Install with Homebrew (recommended; no admin needed)',
          command: 'brew install git',
          requiresAdmin: false,
        });
      }
      options.push({
        label: 'Install Xcode Command Line Tools',
        command: 'xcode-select --install',
        requiresAdmin: true,
      });
      return {
        product: 'Git',
        url: 'https://git-scm.com/download/mac',
        options,
      };
    }
    case 'win32': {
      const options: InstallOption[] = [];
      if (hasWinget()) {
        options.push({
          label: 'Install with winget',
          command: 'winget install --id Git.Git -e --source winget',
          requiresAdmin: true,
        });
      }
      if (hasScoop()) {
        options.push({
          label: 'Install with Scoop (no admin)',
          command: 'scoop install git',
          requiresAdmin: false,
        });
      }
      if (hasChoco()) {
        options.push({
          label: 'Install with Chocolatey',
          command: 'choco install git -y',
          requiresAdmin: true,
        });
      }
      options.push({
        label: 'Download the official installer',
        command: 'Open https://gitforwindows.org/ in your browser',
        requiresAdmin: false,
      });
      return {
        product: 'Git for Windows',
        url: 'https://gitforwindows.org/',
        options,
      };
    }
    default:
      return {
        product: 'Git',
        url: 'https://git-scm.com/download/linux',
        options: linuxInstallOptions(),
      };
  }
}

function linuxInstallOptions(): InstallOption[] {
  const family = detectLinuxFamily();
  switch (family) {
    case 'debian':
      return [{ label: 'Install with apt', command: 'sudo apt install git', requiresAdmin: true }];
    case 'fedora':
      return [{ label: 'Install with dnf', command: 'sudo dnf install git', requiresAdmin: true }];
    case 'arch':
      return [{ label: 'Install with pacman', command: 'sudo pacman -S git', requiresAdmin: true }];
    case 'opensuse':
      return [
        { label: 'Install with zypper', command: 'sudo zypper install git', requiresAdmin: true },
      ];
    case 'alpine':
      return [{ label: 'Install with apk', command: 'sudo apk add git', requiresAdmin: true }];
    default:
      return [
        {
          label: "Use your distribution's package manager",
          command:
            'apt / dnf / pacman / zypper / apk install git (one of these will fit your system)',
          requiresAdmin: true,
        },
      ];
  }
}

export type LinuxFamily = 'debian' | 'fedora' | 'arch' | 'opensuse' | 'alpine' | 'unknown';

/**
 * Detect Linux distribution family from `/etc/os-release`.
 *
 * Reads `ID` + `ID_LIKE` (systemd standard since 2014). `ID_LIKE` covers
 * derivatives — e.g. Pop!_OS has `ID=pop, ID_LIKE="ubuntu debian"`, which we
 * map to `debian`. Quotes are stripped; case-insensitive matching.
 *
 * Returns `'unknown'` if the file is unreadable or no family matches.
 *
 * @internal — exported for test reuse.
 */
export function detectLinuxFamily(osReleaseContents?: string): LinuxFamily {
  let contents = osReleaseContents;
  if (contents === undefined) {
    try {
      contents = readFileSync('/etc/os-release', 'utf-8');
    } catch {
      return 'unknown';
    }
  }
  const id = /^ID=(.+)$/m.exec(contents)?.[1]?.replace(/["']/g, '');
  const idLike = /^ID_LIKE=(.+)$/m.exec(contents)?.[1]?.replace(/["']/g, '') ?? '';
  const tokens = [id, ...idLike.split(/\s+/)].filter((t): t is string => Boolean(t));
  if (tokens.some((t) => /^(debian|ubuntu|mint|pop)$/i.test(t))) return 'debian';
  if (tokens.some((t) => /^(fedora|rhel|centos|alma|rocky)$/i.test(t))) return 'fedora';
  if (tokens.some((t) => /^(arch|manjaro|endeavouros)$/i.test(t))) return 'arch';
  if (tokens.some((t) => /^opensuse/i.test(t)) || tokens.includes('suse')) return 'opensuse';
  if (tokens.some((t) => /^alpine$/i.test(t))) return 'alpine';
  return 'unknown';
}

// ---------- Internal: package-manager probes ----------

/**
 * Probe whether a command is on PATH. Used to filter `InstallGuidance.options`
 * to package managers the user actually has.
 *
 * Uses the OS-native lookup tool (`command -v` via `/bin/sh -c` on POSIX,
 * `where` on Windows) and treats any non-zero exit as "not present".
 */
function hasCommand(name: string): boolean {
  return resolveOnPath(name) !== null;
}

function hasBrew(): boolean {
  return hasCommand('brew');
}
function hasWinget(): boolean {
  return hasCommand('winget');
}
function hasScoop(): boolean {
  return hasCommand('scoop');
}
function hasChoco(): boolean {
  return hasCommand('choco');
}

// ---------- Internal: message builders ----------

function buildMissingMessage(g: InstallGuidance): string {
  const lines: string[] = [];
  lines.push(
    `OpenKnowledge needs ${g.product} to track changes to your knowledge base, but it isn't installed (or isn't on PATH).`,
  );
  lines.push('');
  if (g.options.length > 0) {
    lines.push(`Install ${g.product}:`);
    for (const opt of g.options) {
      const adminTag = opt.requiresAdmin ? ' (admin required)' : '';
      lines.push(`  • ${opt.label}${adminTag}`);
      lines.push(`      ${opt.command}`);
    }
    lines.push('');
  }
  lines.push(`Or download from: ${g.url}`);
  lines.push('');
  lines.push('After installing, re-run OpenKnowledge.');
  lines.push('Run `ok diagnose health --check git` to verify your installation.');
  return lines.join('\n');
}

function buildTooOldMessage(
  detected: string,
  required: string,
  resolvedPath: string,
  g: InstallGuidance,
): string {
  const lines: string[] = [];
  lines.push(
    `OpenKnowledge requires ${g.product} ${required} or newer (detected ${detected} at ${resolvedPath}).`,
  );
  lines.push('');
  if (g.options.length > 0) {
    lines.push(`Update ${g.product}:`);
    for (const opt of g.options) {
      const adminTag = opt.requiresAdmin ? ' (admin required)' : '';
      lines.push(`  • ${opt.label}${adminTag}`);
      lines.push(`      ${opt.command}`);
    }
    lines.push('');
  }
  lines.push(`Or download from: ${g.url}`);
  lines.push('');
  lines.push('After updating, re-run OpenKnowledge.');
  lines.push('Run `ok diagnose health --check git` to verify your installation.');
  return lines.join('\n');
}

// ---------- Internal: semver compare ----------

/**
 * Compare two `MAJOR.MINOR.PATCH` version strings.
 *
 * Returns a negative number when `a < b`, zero when equal, positive when `a > b`.
 * Numeric component-wise comparison — does NOT handle prerelease tags.
 * Sufficient for the git version space (no `2.31.0-rc1`-class strings observed).
 *
 * Missing components default to 0 (so `'2.31' < '2.31.1'`).
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// ---------- Internal: PATH delimiter (re-exported for callers) ----------

/**
 * Re-export `path.delimiter` for callers that need to compose PATH strings
 * (e.g. the Electron spawn-args enrichment in `resolve-detached-spawn-args.ts`).
 * Same value as `path.delimiter`; named here for clarity at call sites.
 */
export const PATH_DELIMITER: string = PATH_DELIM;
