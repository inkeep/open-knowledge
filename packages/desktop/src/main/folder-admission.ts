import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir as nodeHomedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveGitDirDetailed } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { canonicalizeForCompare, isHomeDir, isProjectRoot } from '@inkeep/open-knowledge-server';

const execFileAsync = promisify(execFile);

export type SensitivePathWarning =
  | { readonly kind: 'root' }
  | { readonly kind: 'home' }
  | { readonly kind: 'home-documents' }
  | { readonly kind: 'home-desktop' }
  | { readonly kind: 'home-downloads' }
  | { readonly kind: 'volumes-mount' }
  | { readonly kind: 'drive-root' };

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

  if (/^[A-Za-z]:[\\/]?$/.test(absPath)) {
    warnings.push({ kind: 'drive-root' });
  }

  const resolved = resolve(absPath);

  if (resolved === '/') {
    warnings.push({ kind: 'root' });
  }

  if (resolved === home) {
    warnings.push({ kind: 'home' });
  }

  if (resolved === join(home, 'Documents')) {
    warnings.push({ kind: 'home-documents' });
  }

  if (resolved === join(home, 'Desktop')) {
    warnings.push({ kind: 'home-desktop' });
  }

  if (resolved === join(home, 'Downloads')) {
    warnings.push({ kind: 'home-downloads' });
  }

  if (resolved === '/Volumes' || resolved.startsWith('/Volumes/')) {
    warnings.push({ kind: 'volumes-mount' });
  }

  return { warnings, blocked: false };
}

export type GitState = 'present' | 'absent' | 'shell-only';

export type RejectionReason = 'symlink-escape' | 'unreadable' | 'home-directory';

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
    if (cursor === home || cursor === '/' || cursor === '') break;
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
