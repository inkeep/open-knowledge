/**
 * GitHub OAuth App client ID for OpenKnowledge sign-in.
 * Public — committed to source. Overridable at runtime via the
 * `OPEN_KNOWLEDGE_GITHUB_CLIENT_ID` environment variable.
 */
export const DEFAULT_GITHUB_OAUTH_CLIENT_ID = 'Ov23liqlSd0V1MwR6rhI';

/**
 * Hosts that are known non-GitHub forges. GHES hostnames are arbitrary, so
 * GitHub-ness cannot be allowlisted; any host not listed here is treated as
 * github.com or a GitHub Enterprise Server host. Shared by the CLI `--host`
 * validation and the server's origin-remote classification.
 */
export const KNOWN_NON_GITHUB_GIT_HOSTS: ReadonlySet<string> = new Set([
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'gitea.com',
  'sr.ht',
  'sourcehut.org',
]);

/**
 * Classify a git host for share purposes: lowercase, fold `www.github.com` to
 * `github.com`, and reject known non-GitHub forges. Returns the normalized
 * host (github.com or a presumed-GHES hostname) or `null` for a forge we know
 * isn't GitHub. Single source of truth for the share URL parsers, the folder
 * validator, and the desktop git-remote canonicalizer.
 */
export function classifyGitHubShareHost(hostname: string): string | null {
  const host = hostname.toLowerCase();
  const folded = host === 'www.github.com' ? 'github.com' : host;
  return KNOWN_NON_GITHUB_GIT_HOSTS.has(folded) ? null : folded;
}
