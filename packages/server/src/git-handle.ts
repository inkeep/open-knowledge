import { resolve } from 'node:path';
import simpleGit, { type SimpleGit, type SimpleGitOptions } from 'simple-git';

export { withParentLock } from './git-mutex.ts';

export interface RelayGhToken {
  token: string;
  host: string;
}

interface GitHandleOptions {
  credentialArgs?: string[];
  gitIndexFile?: string;
  ghToken?: RelayGhToken;
}

export interface GitHandle {
  git: SimpleGit;
  projectDir: string;
  credentialArgs: string[];
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
  const env: Record<string, string> = { LANG: 'C', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };
  const path = process.env.PATH ?? process.env.Path;
  if (path !== undefined) {
    env.PATH = path;
  }
  for (const key of GIT_AUTH_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (ghToken) {
    env.OK_GH_TOKEN = ghToken.token;
    env.OK_GH_TOKEN_HOST = ghToken.host;
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

export function createGitInstance(projectDir: string, options: GitHandleOptions = {}): GitHandle {
  const { credentialArgs = [], gitIndexFile, ghToken } = options;

  const env: Record<string, string | undefined> = buildGitEnv(ghToken);
  if (gitIndexFile) {
    env.GIT_INDEX_FILE = resolve(projectDir, gitIndexFile);
  }

  const gitConfig = [
    'commit.gpgsign=false',
    'core.autocrlf=false',
    ...(credentialArgs.length >= 2 ? [credentialArgs[1]] : []),
  ];

  const gitOptions: Partial<CredentialHelperUnsafeGitOptions> = {
    baseDir: projectDir,
    config: gitConfig,
    unsafe: { allowUnsafeCredentialHelper: true },
  };

  const git = simpleGit(gitOptions as Partial<SimpleGitOptions>).env(env as Record<string, string>);

  return { git, projectDir, credentialArgs, env: env as Record<string, string> };
}
