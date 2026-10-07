import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir as nodeHomedir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';
import { resolveGitDirDetailed } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import {
  canonicalizeForCompare,
  isFilesystemRoot,
  isHomeDir,
  isProjectRoot,
} from '@inkeep/open-knowledge-server';

const execFileAsync = promisify(execFile);

export type SensitivePathWarning =
  | { readonly kind: 'home-documents' }
  | { readonly kind: 'home-desktop' }
  | { readonly kind: 'home-downloads' }
  | { readonly kind: 'volumes-mount' };

export interface FolderPickValidation {
  readonly warnings: readonly SensitivePathWarning[];
  readonly blocked: boolean;
}

export interface ValidateFolderPickOptions {
  homeDir?: string;
}

export function validateFolderPick(
  absPath: string,
  opts: ValidateFolderPickOptions = {},
): FolderPickValidation {
  const home = opts.homeDir ?? nodeHomedir();
  const warnings: SensitivePathWarning[] = [];

  const resolved = resolve(absPath);

  if (resolved === join(home, 'Documents')) {
    warnings.push({ kind: 'home-documents' });
  }

  if (resolved === join(home, 'Desktop')) {
    warnings.push({ kind: 'home-desktop' });
  }

  if (resolved === join(home, 'Downloads')) {
    warnings.push({ kind: 'home-downloads' });
  }

  if (resolved.startsWith('/Volumes/')) {
    warnings.push({ kind: 'volumes-mount' });
  }

  return { warnings, blocked: false };
}

export type GitState = 'present' | 'absent' | 'shell-only';

export type RejectionReason =
  | 'symlink-escape'
  | 'unreadable'
  | 'home-directory'
  | 'filesystem-root'
  | 'system-directory';

const POSIX_SYSTEM_DIRECTORIES: ReadonlySet<string> = new Set([
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/proc',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/usr/bin',
  '/usr/lib',
  '/usr/lib32',
  '/usr/lib64',
  '/usr/libx32',
  '/usr/sbin',
  '/var',
  '/private',
  '/private/etc',
  '/private/var',
  '/System',
  '/Library',
  '/Applications',
  '/Volumes',
]);

const WINDOWS_SYSTEM_DIRECTORY_ENV_KEYS = [
  'SystemRoot',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramData',
] as const;

export function isSystemDirectory(
  dir: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const canonical = (p: string) => (platform === process.platform ? canonicalizeForCompare(p) : p);
  if (platform === 'win32') {
    const key = (p: string) => canonical(win32.resolve(p)).toLowerCase();
    const targets = new Set([win32.resolve(dir).toLowerCase(), key(dir)]);
    const candidates = [
      win32.dirname(canonical(win32.resolve(home))),
      ...WINDOWS_SYSTEM_DIRECTORY_ENV_KEYS.flatMap((name) => {
        const value = env[name];
        return value === undefined || value.length === 0 ? [] : [value];
      }),
    ];
    return candidates.some((candidate) => targets.has(key(candidate)));
  }
  const resolved = posix.resolve(dir);
  const homeParent = posix.dirname(canonicalizeForCompare(posix.resolve(home)));
  return [resolved, canonical(resolved)].some(
    (target) => POSIX_SYSTEM_DIRECTORIES.has(target) || target === homeParent,
  );
}

export const REJECTION_REASON_COPY = {
  'symlink-escape': 'Symlink resolves outside its parent directory.',
  unreadable: 'Folder is unreadable or does not exist.',
  'home-directory':
    "This is your home directory, not a project. ~/.ok is OpenKnowledge's own user-global folder (settings, skills), and opening a project here would set up git in your home directory and write project config into your editors' global folders. Make a folder for your notes and open that instead.",
  'filesystem-root':
    'This is the top of a drive, not a project folder. Setting up OpenKnowledge here would scan every file on the drive and set up git at its root. Make a folder for your notes and open that instead.',
  'system-directory':
    'This is a system folder, not a project folder. Make a folder for your notes and open that instead.',
} as const satisfies Record<RejectionReason, string>;

export type DiscoverProjectResult =
  | {
      readonly kind: 'managed';
      readonly pickedPath: string;
      readonly projectDir: string;
      readonly ancestorPromoted: boolean;
    }
  | {
      readonly kind: 'managed-requires-confirmation';
      readonly pickedPath: string;
      readonly projectDir: string;
      readonly ancestorPromoted: true;
    }
  | {
      readonly kind: 'fresh';
      readonly pickedPath: string;
      readonly projectDir: string;
      readonly defaultContentDir: string;
      readonly gitState: GitState;
      readonly gitRootPromoted: boolean;
    }
  | { readonly kind: 'rejected'; readonly reason: RejectionReason };

export function isExactManagedProject(discovery: DiscoverProjectResult): boolean {
  return (
    discovery.kind === 'managed' &&
    discovery.projectDir === discovery.pickedPath &&
    !discovery.ancestorPromoted
  );
}

export interface DiscoverProjectOptions {
  homeDir?: string;
  gitTopLevel?: (cwd: string) => Promise<string | null>;
  dirSizeProbe: ((dir: string) => Promise<{ readonly exceedsCap: boolean }>) | null;
}

const ANCESTOR_WALK_DEPTH_LIMIT = 30;

export async function discoverProject(
  pickedPath: string,
  opts: DiscoverProjectOptions,
): Promise<DiscoverProjectResult> {
  const home = opts.homeDir ?? nodeHomedir();
  const gitTopLevel = opts.gitTopLevel ?? defaultGitTopLevel;
  const dirSizeProbe = opts.dirSizeProbe;
  const absPicked = resolve(pickedPath);

  let realPicked: string;
  let realParent: string;
  try {
    realPicked = realpathSync(absPicked);
    realParent = realpathSync(dirname(absPicked));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'ELOOP' || code === 'ENOENT') {
      return { kind: 'rejected', reason: 'unreadable' };
    }
    throw err;
  }

  if (!isDescendantOrEqual(realPicked, realParent)) {
    return { kind: 'rejected', reason: 'symlink-escape' };
  }

  if (isHomeDir(realPicked, home)) {
    return { kind: 'rejected', reason: 'home-directory' };
  }

  if (isFilesystemRoot(realPicked)) {
    return { kind: 'rejected', reason: 'filesystem-root' };
  }

  if (isSystemDirectory(absPicked, home) || isSystemDirectory(realPicked, home)) {
    return { kind: 'rejected', reason: 'system-directory' };
  }

  if (isPickedPathLinkedWorktreeRoot(realPicked) && !isProjectRoot(realPicked)) {
    return {
      kind: 'fresh',
      pickedPath: realPicked,
      projectDir: realPicked,
      defaultContentDir: '.',
      gitState: computeGitState(realPicked),
      gitRootPromoted: false,
    };
  }

  let cursor = realPicked;
  let depth = 0;
  while (depth < ANCESTOR_WALK_DEPTH_LIMIT) {
    if (
      cursor === '' ||
      isHomeDir(cursor, home) ||
      isFilesystemRoot(cursor) ||
      isSystemDirectory(cursor, home)
    ) {
      break;
    }
    if (isProjectRoot(cursor)) {
      const ancestorPromoted = cursor !== realPicked;
      if (ancestorPromoted && dirSizeProbe !== null) {
        const { exceedsCap } = await dirSizeProbe(cursor);
        if (exceedsCap) {
          return {
            kind: 'managed-requires-confirmation',
            pickedPath: realPicked,
            projectDir: cursor,
            ancestorPromoted: true,
          };
        }
      }
      return {
        kind: 'managed',
        pickedPath: realPicked,
        projectDir: cursor,
        ancestorPromoted,
      };
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
    depth += 1;
  }

  const gitRoot = await gitTopLevel(realPicked);
  let projectDir = realPicked;
  let gitRootPromoted = false;
  if (gitRoot !== null && isDescendantOfHome(gitRoot, home)) {
    projectDir = gitRoot;
    gitRootPromoted = gitRoot !== realPicked;
  }

  return {
    kind: 'fresh',
    pickedPath: realPicked,
    projectDir,
    defaultContentDir: '.',
    gitState: computeGitState(projectDir),
    gitRootPromoted,
  };
}

function isDescendantOrEqual(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function isDescendantOfHome(p: string, home: string): boolean {
  const rel = relative(canonicalizeForCompare(home), canonicalizeForCompare(p));
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function computeGitState(projectDir: string): GitState {
  const dotGit = resolve(projectDir, '.git');
  if (!existsSync(dotGit)) return 'absent';
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(dotGit);
  } catch {
    return 'absent';
  }
  if (!stat.isDirectory()) return 'present';
  if (existsSync(resolve(dotGit, 'HEAD'))) return 'present';
  return 'shell-only';
}

function isPickedPathLinkedWorktreeRoot(pickedPath: string): boolean {
  try {
    const resolved = resolveGitDirDetailed(pickedPath);
    return resolved.kind === 'linked' && resolved.projectSubPath === '';
  } catch {
    return false;
  }
}

export async function defaultGitTopLevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      windowsHide: true,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
