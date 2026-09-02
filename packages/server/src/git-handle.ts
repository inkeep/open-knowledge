import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { augmentGitSpawnPath } from '@inkeep/open-knowledge-core';
import simpleGit, { type SimpleGit, type SimpleGitOptions } from 'simple-git';
import { shellEscape } from './bash/shell-escape.ts';

function isDir(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export { withParentLock } from './git-mutex.ts';

export interface RelayGhToken {
  token: string;
  host: string;
  login?: string;
}

interface GitHandleOptions {
  credentialConfig: string[];
  gitIndexFile?: string;
  ghToken?: RelayGhToken;
  timeoutMs?: number;
}

export interface GitHandle {
  git: SimpleGit;
  projectDir: string;
  credentialConfig: string[];
  env: Record<string, string>;
}

type CredentialHelperUnsafeGitOptions = SimpleGitOptions & {
  unsafe?: NonNullable<SimpleGitOptions['unsafe']> & {
    allowUnsafeCredentialHelper?: boolean;
  };
};

const GIT_AUTH_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ALLUSERSPROFILE',
  'SystemRoot',
  'WINDIR',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'USERNAME',
  'USERDOMAIN',
  'PATHEXT',
  'SSH_AUTH_SOCK',
  'ELECTRON_RUN_AS_NODE',
] as const;

export function buildGitEnv(ghToken?: RelayGhToken): Record<string, string> {
  const env: Record<string, string> = {
    LANG: 'C',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_MERGE_AUTOEDIT: 'no',
  };
  const path = process.env.PATH ?? process.env.Path;
  env.PATH = augmentGitSpawnPath(path, {
    platform: process.platform,
    homeDir: homedir(),
    isDir,
    delimiter,
  });
  for (const key of GIT_AUTH_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (ghToken) {
    env.OK_GH_TOKEN = ghToken.token;
    env.OK_GH_TOKEN_HOST = ghToken.host;
    if (ghToken.login) env.OK_GH_TOKEN_LOGIN = ghToken.login;
  }
  return env;
}

export function applyGitEnv(
  handle: GitHandle,
  overrides: Record<string, string | undefined>,
): SimpleGit {
  const env = { ...handle.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
  }
  return handle.git.env(env);
}

export function createGitInstance(projectDir: string, options: GitHandleOptions): GitHandle {
  const { credentialConfig, gitIndexFile, ghToken, timeoutMs } = options;

  const env: Record<string, string | undefined> = buildGitEnv(ghToken);
  if (gitIndexFile) {
    env.GIT_INDEX_FILE = resolve(projectDir, gitIndexFile);
  }

  const gitConfig = [
    'commit.gpgsign=false',
    'core.autocrlf=false',
    'credential.interactive=false',
    ...credentialConfig,
  ];

  const gitOptions: Partial<CredentialHelperUnsafeGitOptions> = {
    baseDir: projectDir,
    config: gitConfig,
    unsafe: { allowUnsafeCredentialHelper: true },
    ...(timeoutMs === undefined ? {} : { timeout: { block: timeoutMs } }),
  };

  const git = simpleGit(gitOptions as Partial<SimpleGitOptions>).env(env as Record<string, string>);

  return { git, projectDir, credentialConfig, env: env as Record<string, string> };
}

export function buildSyncCredentialConfig(
  localOpCliArgs: string[] | undefined,
  opts: { resetAmbient: boolean },
): string[] {
  const argv = localOpCliArgs && localOpCliArgs.length > 0 ? localOpCliArgs : ['open-knowledge'];
  const cliPrefix = argv.map(shellEscape).join(' ');
  const helper = `credential.helper=!${cliPrefix} auth git-credential`;
  return opts.resetAmbient ? ['credential.helper=', helper] : [helper];
}
