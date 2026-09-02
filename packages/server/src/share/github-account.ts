import { spawnSync } from 'node:child_process';
import { withHiddenWindowsConsole } from '../child-process-windows-hide.ts';
import { getLogger } from '../logger.ts';
import { asDeclaredGitHubLogin, parseGitHubOriginUrl, readOriginRemoteUrl } from './git-context.ts';
import { redactShareSubprocessStderr } from './publish.ts';

const log = getLogger('github-account');

export type GitHubAccountSource = 'remote-url' | 'credential-config' | 'active';

export type GitHubAccount =
  | { source: 'active'; host?: string; login?: undefined }
  | { source: Exclude<GitHubAccountSource, 'active'>; host: string; login: string };

export type CredentialUrlMatchReader = (url: string, cwd: string) => string | null;

export interface ResolveGitHubAccountOptions {
  cwd?: string;
  _readCredentialUrlMatch?: CredentialUrlMatchReader;
}

const defaultCredentialUrlMatchReader: CredentialUrlMatchReader = (url, cwd) => {
  const result = spawnSync(
    'git',
    ['config', '--get-urlmatch', 'credential', url],
    withHiddenWindowsConsole({ cwd, encoding: 'utf-8', timeout: 5_000 }),
  );
  if (result.error || result.status === null || (result.status !== 0 && result.status !== 1)) {
    log.warn(
      {
        status: result.status,
        signal: result.signal,
        err: result.error,
        stderr:
          typeof result.stderr === 'string'
            ? redactShareSubprocessStderr(result.stderr).slice(0, 200)
            : undefined,
      },
      '[github-account] git config --get-urlmatch failed — treating the URL as declaring no account',
    );
    return null;
  }
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout;
};

function stripUserinfoForLookup(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1');
}

function credentialUsernameFrom(stdout: string): string | undefined {
  let username: string | undefined;
  for (const line of stdout.split('\n')) {
    const value = line.startsWith('credential.username ')
      ? line.slice('credential.username '.length).trim()
      : undefined;
    if (value) username = value;
  }
  return username;
}

export function resolveGitHubAccountFromUrl(
  url: string,
  options: ResolveGitHubAccountOptions = {},
): GitHubAccount {
  const parsed = parseGitHubOriginUrl(url);
  if (!parsed) return { source: 'active' };

  const host = parsed.host;
  if (parsed.login) return { host, login: parsed.login, source: 'remote-url' };

  if (parsed.transport !== 'https') return { host, source: 'active' };

  const read = options._readCredentialUrlMatch ?? defaultCredentialUrlMatchReader;
  const stdout = read(stripUserinfoForLookup(url), options.cwd ?? process.cwd());
  const login = stdout ? asDeclaredGitHubLogin(credentialUsernameFrom(stdout)) : undefined;
  return login ? { host, login, source: 'credential-config' } : { host, source: 'active' };
}

export interface CachedGitHubAccountResolverOptions {
  ttlMs?: number;
  now?: () => number;
  _readCredentialUrlMatch?: CredentialUrlMatchReader;
}

export interface CachedGitHubAccountResolver {
  resolve(projectDir: string): GitHubAccount;
  invalidate(): void;
}

const DEFAULT_RESOLUTION_TTL_MS = 60_000;

export function createCachedGitHubAccountResolver(
  options: CachedGitHubAccountResolverOptions = {},
): CachedGitHubAccountResolver {
  const ttlMs = options.ttlMs ?? DEFAULT_RESOLUTION_TTL_MS;
  const now = options.now ?? Date.now;
  let cached:
    | { projectDir: string; url: string; account: GitHubAccount; expiresAt: number }
    | undefined;

  return {
    resolve(projectDir: string): GitHubAccount {
      const url = readOriginRemoteUrl(projectDir);
      if (!url) return { source: 'active' };
      const t = now();
      if (
        cached &&
        cached.projectDir === projectDir &&
        cached.url === url &&
        cached.expiresAt > t
      ) {
        return cached.account;
      }
      const account = resolveGitHubAccountFromUrl(url, {
        cwd: projectDir,
        _readCredentialUrlMatch: options._readCredentialUrlMatch,
      });
      cached = { projectDir, url, account, expiresAt: t + ttlMs };
      return account;
    },

    invalidate(): void {
      cached = undefined;
    },
  };
}
