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

const GIT_CREDENTIAL_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;

export function isGitCredentialHost(host: string): boolean {
  return GIT_CREDENTIAL_HOST_PATTERN.test(host);
}

const DEFAULT_PORT_BY_PROTOCOL: Readonly<Record<string, string>> = { https: '443', http: '80' };

export function gitCredentialHostKey(host: string, protocol = 'https'): string {
  const lower = host.trim().toLowerCase();
  const defaultPort = DEFAULT_PORT_BY_PROTOCOL[protocol.toLowerCase()];
  return defaultPort !== undefined && lower.endsWith(`:${defaultPort}`)
    ? lower.slice(0, -(defaultPort.length + 1))
    : lower;
}

export function credentialHostFromRemoteUrl(remoteUrl: string): string | null {
  const raw = remoteUrl.trim();
  const http = /^(https?):\/\/(?:[^/]*@)?([\w.-]+(?::\d+)?)(?:[/?#]|$)/i.exec(raw);
  if (http) return gitCredentialHostKey(http[2], http[1]);
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/]*@)?([\w.-]+)(?::\d+)?(?:[/?#]|$)/i.exec(raw);
  if (url) return url[1].toLowerCase();
  const scp = /^(?:[^@/]+@)?([\w.-]+):(?!\/\/|\\)/.exec(raw);
  return scp ? scp[1].toLowerCase() : null;
}

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
