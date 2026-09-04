import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const DEFAULT_BRANCH_NAMES = new Set(['main', 'master']);

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

export function deriveAutoInstanceName(ctx: GitInstanceContext): string | null {
  const branch = ctx.branch;
  if (branch && branch !== 'HEAD') {
    if (DEFAULT_BRANCH_NAMES.has(branch)) return null;
    return branch;
  }
  if (ctx.worktreeDir) {
    const base = basename(ctx.worktreeDir);
    return base.length > 0 ? base : null;
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
