import { KNOWN_NON_GITHUB_GIT_HOSTS } from '@inkeep/open-knowledge-core';
import {
  type GitRepository,
  inspectGitRepository,
} from '@inkeep/open-knowledge-core/git-repository';
import { getLogger } from '../logger.ts';

const log = getLogger('git-context');

export type OriginTransport = 'https' | 'ssh' | 'git';

export type OriginResult =
  | {
      kind: 'ok';
      host: string;
      owner: string;
      repo: string;
      transport: OriginTransport;
    }
  | { kind: 'no-remote' }
  | { kind: 'non-github' };

function readRepository(projectDir: string): GitRepository | null {
  const result = inspectGitRepository(projectDir);
  return result.kind === 'repository' ? result.repository : null;
}

export function readGitHeadBranch(projectDir: string): string | null {
  const head = readRepository(projectDir)?.readHead();
  return head?.kind === 'branch' ? head.branch : null;
}

export interface ParsedOriginRepo {
  host: string;
  owner: string;
  repo: string;
  transport: OriginTransport;
  login?: string;
}

function normalizeGitHost(rawHost: string): string {
  const host = rawHost.toLowerCase().replace(/:\d+$/, '');
  return host === 'www.github.com' ? 'github.com' : host;
}

const USERINFO_PLACEHOLDER_USERS = new Set([
  'git',
  'x-access-token',
  'x-oauth-basic',
  'oauth2',
  'token',
]);

const GITHUB_TOKEN_PREFIX = /^(?:gh[opsur]_|github_pat_)/;

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|[-_](?=[A-Za-z0-9])){0,38}$/;

function isGitHubLoginShaped(value: string): boolean {
  return !GITHUB_TOKEN_PREFIX.test(value) && GITHUB_LOGIN.test(value);
}

export function sameGitHubLogin(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

function loginFromUserinfo(userinfo: string | undefined): string | undefined {
  if (!userinfo) return undefined;
  const colon = userinfo.indexOf(':');
  const user = colon === -1 ? userinfo : userinfo.slice(0, colon);
  if (!user) return undefined;
  return asDeclaredGitHubLogin(decodeUserinfo(user));
}

export function asDeclaredGitHubLogin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (USERINFO_PLACEHOLDER_USERS.has(raw)) return undefined;
  return isGitHubLoginShaped(raw) ? raw : undefined;
}

export function loginShapedUserinfoUser(user: string): string | undefined {
  if (!user) return undefined;
  const decoded = decodeUserinfo(user);
  return isGitHubLoginShaped(decoded) ? decoded : undefined;
}

function decodeUserinfo(user: string): string {
  if (!user.includes('%')) return user;
  try {
    return decodeURIComponent(user);
  } catch {
    return user;
  }
}

export function parseGitHubOriginUrl(originUrl: string): ParsedOriginRepo | null {
  const raw = originUrl.trim();
  if (!raw) return null;

  const classify = (
    host: string,
    owner: string,
    repo: string,
    transport: OriginTransport,
    userinfo?: string,
  ): ParsedOriginRepo | null => {
    const normalized = normalizeGitHost(host);
    if (KNOWN_NON_GITHUB_GIT_HOSTS.has(normalized)) return null;
    const login = loginFromUserinfo(userinfo);
    return login === undefined
      ? { host: normalized, owner, repo, transport }
      : { host: normalized, owner, repo, transport, login };
  };

  let m =
    /^https?:\/\/(?:([^/]*)@)?([\w.-]+(?::\d+)?)\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(
      raw,
    );
  if (m) return classify(m[2], m[3], m[4], 'https', m[1]);

  m = /^ssh:\/\/(?:([^/]*)@)?([\w.-]+)(?::\d+)?\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(
    raw,
  );
  if (m) return classify(m[2], m[3], m[4], 'ssh', m[1]);

  m = /^([\w.\-~%]+)@([\w.-]+):([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?$/.exec(raw);
  if (m) return classify(m[2], m[3], m[4], 'ssh', m[1]);

  m = /^git:\/\/([\w.-]+(?::\d+)?)\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(raw);
  if (m) return classify(m[1], m[2], m[3], 'git');

  return null;
}

export function readOriginRemoteUrl(projectDir: string): string | null {
  const origin = readRepository(projectDir)?.readRemoteUrl('origin');
  return origin?.kind === 'configured' ? origin.url : null;
}

function readParsedOrigin(
  projectDir: string,
): { originUrl: string; github: ParsedOriginRepo | null } | null {
  const origin = readRepository(projectDir)?.readRemoteUrl('origin');
  if (origin?.kind !== 'configured') return null;
  const originUrl = origin.url;
  return { originUrl, github: parseGitHubOriginUrl(originUrl) };
}

export function readOriginGitHubRepo(projectDir: string): OriginResult {
  const parsed = readParsedOrigin(projectDir);
  if (!parsed) return { kind: 'no-remote' };
  if (parsed.github) {
    const { host, owner, repo, transport } = parsed.github;
    return { kind: 'ok', host, owner, repo, transport };
  }
  return { kind: 'non-github' };
}

export function originGitHubHost(projectDir: string): string {
  const origin = readOriginGitHubRepo(projectDir);
  if (origin.kind === 'ok') return origin.host;
  log.debug(
    { kind: origin.kind },
    '[git-context] origin is not a GitHub host — falling back to github.com',
  );
  return 'github.com';
}

export function shouldResetAmbientCredentials(projectDir: string): boolean {
  return readOriginGitHubRepo(projectDir).kind !== 'non-github';
}

export interface SyncRemoteInfo {
  label: string;
  webUrl: string | null;
}

export function readSyncRemoteInfo(projectDir: string): SyncRemoteInfo | null {
  const parsed = readParsedOrigin(projectDir);
  if (!parsed) return null;
  if (parsed.github) {
    const { host, owner, repo } = parsed.github;
    return {
      label: host === 'github.com' ? `${owner}/${repo}` : `${host}/${owner}/${repo}`,
      webUrl: `https://${host}/${owner}/${repo}`,
    };
  }
  return { label: labelFromNonGitHubUrl(parsed.originUrl), webUrl: null };
}

function labelFromNonGitHubUrl(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, '');
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(trimmed);
  if (scp) return `${scp[1]}/${scp[2]}`;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)*(.+)$/i.exec(trimmed);
  if (scheme) return scheme[1];
  return trimmed;
}

export function branchExistsOnOrigin(projectDir: string, branch: string): boolean {
  return readRepository(projectDir)?.readRef(`refs/remotes/origin/${branch}`).kind === 'present';
}
