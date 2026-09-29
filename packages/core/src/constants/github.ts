export const DEFAULT_GITHUB_OAUTH_CLIENT_ID = 'Ov23liqlSd0V1MwR6rhI';

export const GIT_HOST_PROVIDERS = ['github'] as const;

export type GitHostProvider = (typeof GIT_HOST_PROVIDERS)[number];

const KNOWN_NON_GITHUB_GIT_HOSTS: ReadonlySet<string> = new Set([
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'gitea.com',
  'sr.ht',
  'sourcehut.org',
]);

export function normalizeGitHostname(raw: string): string {
  const host = raw.toLowerCase().replace(/:\d+$/, '');
  return host === 'www.github.com' ? 'github.com' : host;
}

export function isGitHubHost(hostname: string, declaredGitHubHosts?: ReadonlySet<string>): boolean {
  const host = normalizeGitHostname(hostname);
  return host === 'github.com' || declaredGitHubHosts?.has(host) === true;
}

export function declaredGitHubHostsFrom(
  hosts: Readonly<Record<string, { provider?: GitHostProvider } | undefined>> | undefined,
): ReadonlySet<string> {
  const declared = new Set<string>();
  if (!hosts) return declared;
  for (const [hostname, entry] of Object.entries(hosts)) {
    if (entry?.provider !== 'github') continue;
    const normalized = normalizeGitHostname(hostname);
    if (normalized) declared.add(normalized);
  }
  return declared;
}

export function classifyGitHubShareHost(hostname: string): string | null {
  const host = hostname.toLowerCase();
  const folded = host === 'www.github.com' ? 'github.com' : host;
  return KNOWN_NON_GITHUB_GIT_HOSTS.has(folded) ? null : folded;
}
