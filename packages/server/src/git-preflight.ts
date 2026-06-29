
import { type SpawnSyncOptions, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter as PATH_DELIM } from 'node:path';

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

const PROBE_TIMEOUT_MS = 5000;


export interface GitDetected {
  readonly ok: true;
  readonly version: string;
  /** Absolute path actually invoked. Invaluable for debugging
   *  "installed but not detected" reports. */
  readonly resolvedPath: string;
  readonly source: 'PATH' | 'fallback';
}

export interface InstallOption {
  readonly label: string;
  readonly command: string;
  readonly requiresAdmin: boolean;
}

export interface InstallGuidance {
  readonly product: string;
  readonly options: readonly InstallOption[];
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


export function detectGit(): GitDetected {
  const stage1 = probeGit('git');
  if (stage1.kind === 'ok') {
    return {
      ok: true,
      version: stage1.version,
      resolvedPath: stage1.resolvedPath,
      source: 'PATH',
    };
  }

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


type ProbeResult =
  | { kind: 'ok'; version: string; resolvedPath: string }
  | { kind: 'fail'; reason: 'enoent' | 'unparseable' | 'timeout' | 'nonzero' };

function probeGit(command: string): ProbeResult {
  const opts: SpawnSyncOptions = {
    encoding: 'utf-8',
    timeout: PROBE_TIMEOUT_MS,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  };
  const result = spawnSync(command, ['--version'], opts);
  if (result.error) {
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

export function parseGitVersion(stdout: string): string | null {
  const match = stdout.match(/git version (\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

const SAFE_COMMAND_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

const resolveOnPathCache = new Map<string, string>();

export function __resetResolveOnPathCacheForTests(): void {
  resolveOnPathCache.clear();
}

export function __seedResolveOnPathCacheForTests(name: string, resolvedPath: string): void {
  resolveOnPathCache.set(name, resolvedPath);
}

export function resolveOnPath(name: string): string | null {
  if (!SAFE_COMMAND_NAME_RE.test(name)) return null;
  const cached = resolveOnPathCache.get(name);
  if (cached !== undefined) return cached;
  let resolved: string | null;
  if (process.platform === 'win32') {
    const result = spawnSync('where', [name], { encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS });
    if (result.status !== 0) {
      resolved = null;
    } else {
      const first = (typeof result.stdout === 'string' ? result.stdout : '')
        .trim()
        .split(/\r?\n/)[0];
      resolved = first || null;
    }
  } else {
    const result = spawnSync('/bin/sh', ['-c', `command -v ${name}`], {
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
    });
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


export const PATH_DELIMITER: string = PATH_DELIM;
