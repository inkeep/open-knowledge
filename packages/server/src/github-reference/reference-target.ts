import { isGitHubHost, normalizeGitHostname } from '@inkeep/open-knowledge-core';

export interface GitHubReferenceTarget {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly kind: 'pull' | 'issues';
}

const REFERENCE_PATH =
  /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/(pull|issues)\/(\d{1,10})(?:\/[^?#]*)?$/;

export function parseGitHubReferenceUrl(
  raw: string,
  declaredGitHubHosts: ReadonlySet<string>,
): GitHubReferenceTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    return null;
  }
  const host = normalizeGitHostname(url.hostname);
  if (!isGitHubHost(host, declaredGitHubHosts)) return null;
  const match = REFERENCE_PATH.exec(url.pathname);
  if (match === null) return null;
  const [, owner, repo, kind, digits] = match;
  if (owner === undefined || repo === undefined || repo === '.' || repo === '..') return null;
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { host, owner, repo, number, kind: kind === 'pull' ? 'pull' : 'issues' };
}

export function gitHubReferenceKey(target: GitHubReferenceTarget): string {
  return `${target.host}/${target.owner}/${target.repo}#${target.number}`.toLowerCase();
}
