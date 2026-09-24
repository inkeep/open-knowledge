import { type Config, normalizeGitHostname } from '@inkeep/open-knowledge-core';

export type EnterpriseHostInputResult =
  | { ok: true; host: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'github-com' | 'duplicate' };

const HOSTNAME_LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const HOSTNAME = new RegExp(`^${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})*$`);
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function hostPortOf(raw: string): string | null {
  if (SCHEME.test(raw)) {
    try {
      return new URL(raw).host;
    } catch {
      return null;
    }
  }
  const authority = raw.split('/')[0] ?? '';
  const withoutUser = authority.slice(authority.lastIndexOf('@') + 1);
  return withoutUser.replace(/:(?!\d+$).*$/, '');
}

export function parseEnterpriseHostInput(
  raw: string,
  declared: ReadonlySet<string>,
): EnterpriseHostInputResult {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  const hostPort = hostPortOf(trimmed);
  if (hostPort === null || hostPort === '') return { ok: false, reason: 'invalid' };
  const host = normalizeGitHostname(hostPort);
  if (!HOSTNAME.test(host)) return { ok: false, reason: 'invalid' };
  if (host === 'github.com') return { ok: false, reason: 'github-com' };
  if (declared.has(host)) return { ok: false, reason: 'duplicate' };
  return { ok: true, host };
}

export function declaredEnterpriseHosts(config: Config): string[] {
  const hosts = config.git?.hosts ?? {};
  return Object.entries(hosts)
    .filter(([, entry]) => entry?.provider === 'github')
    .map(([host]) => host)
    .sort((a, b) => a.localeCompare(b));
}
