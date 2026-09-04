export const DEFAULT_GITHUB_OAUTH_CLIENT_ID = 'Ov23liqlSd0V1MwR6rhI';

export const KNOWN_NON_GITHUB_GIT_HOSTS: ReadonlySet<string> = new Set([
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'gitea.com',
  'sr.ht',
  'sourcehut.org',
]);

export function classifyGitHubShareHost(hostname: string): string | null {
  const host = hostname.toLowerCase();
  const folded = host === 'www.github.com' ? 'github.com' : host;
  return KNOWN_NON_GITHUB_GIT_HOSTS.has(folded) ? null : folded;
}
