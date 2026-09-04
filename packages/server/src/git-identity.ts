import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';

interface GitIdentity {
  name: string;
  email: string;
}

export interface GitIdentityTokenStore {
  get(host: string): Promise<{ login: string; name?: string; email?: string } | null>;
}

export type GitConfigReader = (projectDir: string, key: string) => string | null;

const defaultGitConfigReader: GitConfigReader = (projectDir, key) => {
  const result = spawnSync(
    'git',
    ['config', '--get', key],
    withHiddenWindowsConsole({
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    }),
  );
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout.trim() || null;
};

function isLinkedWorktree(projectDir: string): boolean {
  const gd = spawnSync(
    'git',
    ['rev-parse', '--git-dir'],
    withHiddenWindowsConsole({
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    }),
  );
  const cd = spawnSync(
    'git',
    ['rev-parse', '--git-common-dir'],
    withHiddenWindowsConsole({
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    }),
  );
  if (gd.status !== 0 || cd.status !== 0) return false;
  const gdPath = resolve(projectDir, gd.stdout.trim());
  const cdPath = resolve(projectDir, cd.stdout.trim());
  return gdPath !== cdPath;
}

function ensureWorktreeConfigExtension(projectDir: string): void {
  const probe = spawnSync(
    'git',
    ['config', '--local', '--get', 'extensions.worktreeConfig'],
    withHiddenWindowsConsole({
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    }),
  );
  if (probe.status === 0 && /^(true|yes|on|1)$/i.test(probe.stdout.trim())) return;

  const enable = spawnSync(
    'git',
    ['config', '--local', 'extensions.worktreeConfig', 'true'],
    withHiddenWindowsConsole({
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    }),
  );
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
  const configName = _reader(projectDir, 'user.name');
  const configEmail = _reader(projectDir, 'user.email');
  if (configName && configEmail) {
    return { name: configName, email: configEmail };
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
    const result = spawnSync(
      'git',
      ['config', scopeFlag, key, value],
      withHiddenWindowsConsole({
        cwd: projectDir,
        encoding: 'utf-8',
        timeout: 5_000,
      }),
    );
    if (result.status !== 0) {
      const stderr = result.stderr?.trim() ?? '';
      const spawnErr = result.error ? ` [${result.error.message}]` : '';
      throw new Error(`git config ${scopeFlag} ${key} failed: ${stderr}${spawnErr}`);
    }
  };
  setConfig('user.name', name);
  setConfig('user.email', email);
}
