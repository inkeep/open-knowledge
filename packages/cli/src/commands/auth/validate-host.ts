import { KNOWN_NON_GITHUB_GIT_HOSTS } from '@inkeep/open-knowledge-core';

/**
 * Reject hosts that are known non-GitHub forges. Unknown hosts are allowed
 * through — they may be GitHub Enterprise Server instances. The denylist is
 * shared with the server's origin-remote classification
 * (`KNOWN_NON_GITHUB_GIT_HOSTS` in core) so the two can never drift.
 */
export function validateGitHubHost(host: string): void {
  const normalized = host.toLowerCase().replace(/:\d+$/, '');
  if (KNOWN_NON_GITHUB_GIT_HOSTS.has(normalized)) {
    process.stderr.write(
      `Error: ${host} is not a GitHub host. Only GitHub and GitHub Enterprise Server are supported.\n`,
    );
    process.exit(1);
  }
}
