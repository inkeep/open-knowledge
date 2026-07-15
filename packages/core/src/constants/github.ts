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
