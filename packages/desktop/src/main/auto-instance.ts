import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { sanitizeInstanceName } from './instance-isolation.ts';

const DEFAULT_BRANCH_NAMES = new Set(['main', 'master']);
const DEFAULT_BRANCH_INSTANCE = 'dev';
const NON_DEFAULT_DEV_INSTANCE = 'dev..branch';

export interface GitInstanceContext {
  readonly branch: string | null;
  readonly worktreeDir: string | null;
}

function runGit(args: readonly string[], dir: string): string | null {
  try {
    const out = execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function readGitInstanceContext(dir: string): GitInstanceContext {
  return {
    branch: runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir),
    worktreeDir: runGit(['rev-parse', '--show-toplevel'], dir),
  };
}

function avoidDefaultBranchInstance(name: string): string {
  return sanitizeInstanceName(name).toLowerCase() === DEFAULT_BRANCH_INSTANCE
    ? NON_DEFAULT_DEV_INSTANCE
    : name;
}

export function deriveAutoInstanceName(ctx: GitInstanceContext): string | null {
  const branch = ctx.branch;
  if (branch && branch !== 'HEAD') {
    if (DEFAULT_BRANCH_NAMES.has(branch)) return DEFAULT_BRANCH_INSTANCE;
    return avoidDefaultBranchInstance(branch);
  }
  if (ctx.worktreeDir) {
    const base = basename(ctx.worktreeDir);
    return base.length > 0 ? avoidDefaultBranchInstance(base) : null;
  }
  return null;
}

export function resolveEffectiveInstanceName(
  env: { readonly OK_INSTANCE?: string; readonly OK_AUTO_INSTANCE?: string },
  appDir: string,
  opts: {
    readonly readGit?: (dir: string) => GitInstanceContext;
    readonly autoDeriveEnabled?: boolean;
  } = {},
): { name: string; source: 'env' | 'git' } | null {
  const explicit = env.OK_INSTANCE?.trim();
  if (explicit) return { name: explicit, source: 'env' };
  if (opts.autoDeriveEnabled === false) return null;
  if (/^(0|false|off)$/i.test(env.OK_AUTO_INSTANCE ?? '')) return null;
  const readGit = opts.readGit ?? readGitInstanceContext;
  const derived = deriveAutoInstanceName(readGit(appDir));
  return derived ? { name: derived, source: 'git' } : null;
}
