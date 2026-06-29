
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';


interface GitIdentity {
  name: string;
  email: string;
}

export interface GitIdentityTokenStore {
  get(host: string): Promise<{ login: string; name?: string; email?: string } | null>;
}

export type GitConfigReader = (
  projectDir: string,
  key: string,
  scope: 'worktree' | 'local' | 'global',
) => string | null;


const defaultGitConfigReader: GitConfigReader = (projectDir, key, scope) => {
  const scopeFlag =
    scope === 'worktree' ? '--worktree' : scope === 'local' ? '--local' : '--global';
  const result = spawnSync('git', ['config', scopeFlag, key], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout.trim() || null;
};


function isLinkedWorktree(projectDir: string): boolean {
  const gd = spawnSync('git', ['rev-parse', '--git-dir'], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 5_000,
  });
  const cd = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (gd.status !== 0 || cd.status !== 0) return false;
  const gdPath = resolve(projectDir, gd.stdout.trim());
  const cdPath = resolve(projectDir, cd.stdout.trim());
  return gdPath !== cdPath;
}

function ensureWorktreeConfigExtension(projectDir: string): void {
  const probe = spawnSync('git', ['config', '--local', '--get', 'extensions.worktreeConfig'], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (probe.status === 0 && /^(true|yes|on|1)$/i.test(probe.stdout.trim())) return;

  const enable = spawnSync('git', ['config', '--local', 'extensions.worktreeConfig', 'true'], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (enable.status !== 0) {
    const stderr = enable.stderr?.trim() ?? '';
    const spawnErr = enable.error ? ` [${enable.error.message}]` : '';
    throw new Error(`failed to enable extensions.worktreeConfig: ${stderr}${spawnErr}`);
  }
}


export async function resolveGitIdentity(
  projectDir: string,
  tokenStore?: GitIdentityTokenStore | null,
  host?: string | null,
  _reader: GitConfigReader = defaultGitConfigReader,
): Promise<GitIdentity | null> {
  const worktreeName = _reader(projectDir, 'user.name', 'worktree');
  const worktreeEmail = _reader(projectDir, 'user.email', 'worktree');
  if (worktreeName && worktreeEmail) {
    return { name: worktreeName, email: worktreeEmail };
  }

  const localName = _reader(projectDir, 'user.name', 'local');
  const localEmail = _reader(projectDir, 'user.email', 'local');
  if (localName && localEmail) {
    return { name: localName, email: localEmail };
  }

  const globalName = _reader(projectDir, 'user.name', 'global');
  const globalEmail = _reader(projectDir, 'user.email', 'global');
  if (globalName && globalEmail) {
    return { name: globalName, email: globalEmail };
  }

  if (tokenStore && host) {
    const entry = await tokenStore.get(host);
    if (entry) {
      const name = entry.name ?? entry.login;
      const email = entry.email ?? `${entry.login}@users.noreply.github.com`;
      if (name) {
        return { name, email };
      }
    }
  }

  return null;
}

export function writeGitIdentity(projectDir: string, name: string, email: string): void {
  let scopeFlag: '--worktree' | '--local' = '--local';
  if (isLinkedWorktree(projectDir)) {
    ensureWorktreeConfigExtension(projectDir);
    scopeFlag = '--worktree';
  }
  const setConfig = (key: string, value: string) => {
    const result = spawnSync('git', ['config', scopeFlag, key, value], {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    });
    if (result.status !== 0) {
      const stderr = result.stderr?.trim() ?? '';
      const spawnErr = result.error ? ` [${result.error.message}]` : '';
      throw new Error(`git config ${scopeFlag} ${key} failed: ${stderr}${spawnErr}`);
    }
  };
  setConfig('user.name', name);
  setConfig('user.email', email);
}
