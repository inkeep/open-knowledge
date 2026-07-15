import { originGitHubHost } from '@inkeep/open-knowledge-server';
import { Octokit } from '@octokit/rest';
import { Command } from 'commander';
import { detectGh } from '../../auth/gh-detect.ts';
import type { TokenStore } from '../../auth/token-store.ts';
import { validateGitHubHost } from './validate-host.ts';

interface ReposOptions {
  host: string;
  json: boolean;
}

/**
 * Pick the credential source for an `auth repos` call: gh delegation first,
 * stored token second, null third. `_detectGhFn` is injectable for tests so
 * we can drive the cascade without spawning `gh`.
 */
export async function resolveReposToken(
  host: string,
  tokenStore: TokenStore,
  _detectGhFn: (host?: string) => ReturnType<typeof detectGh> = detectGh,
): Promise<string | null> {
  const gh = _detectGhFn(host);
  if (gh.available && gh.token) return gh.token;
  const entry = await tokenStore.get(host);
  return entry?.token ?? null;
}

async function runRepos(opts: ReposOptions, tokenStore: TokenStore): Promise<void> {
  const { host, json } = opts;
  validateGitHubHost(host);
  const token = await resolveReposToken(host, tokenStore);
  if (token == null) {
    process.stderr.write(`Not logged in to ${host}\n`);
    process.exit(1);
  }

  // Fallback for github enterprise instances
  const baseUrl = host === 'github.com' ? undefined : `https://${host}/api/v3`;
  const octokit = new Octokit({ auth: token, ...(baseUrl ? { baseUrl } : {}) });

  const repos: { full_name: string; clone_url: string; private: boolean }[] = [];
  for await (const response of octokit.paginate.iterator(octokit.repos.listForAuthenticatedUser, {
    per_page: 100,
    sort: 'updated',
  })) {
    for (const repo of response.data) {
      repos.push({ full_name: repo.full_name, clone_url: repo.clone_url, private: repo.private });
    }
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ type: 'repos', host, repos })}\n`);
  } else {
    for (const r of repos) {
      process.stdout.write(`${r.full_name}  ${r.clone_url}\n`);
    }
  }
}

export function reposCommand(getTokenStore: () => Promise<TokenStore>): Command {
  return new Command('repos')
    .description('List accessible repositories')
    .option(
      '--host <host>',
      'GitHub or GitHub Enterprise hostname (default: workspace origin host)',
    )
    .option('--json', 'Output JSON', false)
    .action(async (opts: Omit<ReposOptions, 'host'> & { host?: string }) => {
      const host = opts.host ?? originGitHubHost(process.cwd());
      await runRepos({ ...opts, host }, await getTokenStore());
    });
}
