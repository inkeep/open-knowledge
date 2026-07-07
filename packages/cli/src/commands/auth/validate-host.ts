const KNOWN_NON_GITHUB_HOSTS = new Set([
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'gitea.com',
  'sr.ht',
  'sourcehut.org',
]);

/**
 * Reject hosts that are known non-GitHub forges. Unknown hosts are allowed
 * through — they may be GitHub Enterprise Server instances.
 */
export function validateGitHubHost(host: string): void {
  const normalized = host.toLowerCase().replace(/:\d+$/, '');
  if (KNOWN_NON_GITHUB_HOSTS.has(normalized)) {
    process.stderr.write(
      `Error: ${host} is not a GitHub host. Only GitHub and GitHub Enterprise Server are supported.\n`,
    );
    process.exit(1);
  }
}
