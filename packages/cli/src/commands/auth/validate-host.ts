import { KNOWN_NON_GITHUB_GIT_HOSTS } from '@inkeep/open-knowledge-core';

export function validateGitHubHost(host: string): void {
  const normalized = host.toLowerCase().replace(/:\d+$/, '');
  if (KNOWN_NON_GITHUB_GIT_HOSTS.has(normalized)) {
    process.stderr.write(
      `Error: ${host} is not a GitHub host. Only GitHub and GitHub Enterprise Server are supported.\n`,
    );
    process.exit(1);
  }
}
