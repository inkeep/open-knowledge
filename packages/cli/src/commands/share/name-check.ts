
import { Octokit } from '@octokit/rest';
import { Command } from 'commander';
import type { TokenStore } from '../../auth/token-store.ts';
import { resolveReposToken } from '../auth/repos.ts';
import { validateGitHubHost } from '../auth/validate-host.ts';

interface NameCheckOptions {
  host: string;
  owner: string;
  name: string;
  json: boolean;
}

type NameCheckResult =
  | { kind: 'ok'; available: boolean }
  | { kind: 'auth-required' }
  | { kind: 'network' };

export async function checkSharePublishName(
  octokit: Octokit,
  owner: string,
  name: string,
): Promise<NameCheckResult> {
  try {
    await octokit.repos.get({ owner, repo: name });
    return { kind: 'ok', available: false };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return { kind: 'ok', available: true };
    if (status === 401) return { kind: 'auth-required' };
    return { kind: 'network' };
  }
}

async function runShareNameCheck(opts: NameCheckOptions, tokenStore: TokenStore): Promise<void> {
  const { host, owner, name, json } = opts;
  validateGitHubHost(host);
  const token = await resolveReposToken(host, tokenStore);
  if (token == null) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ type: 'error', code: 'auth-required' })}\n`);
      return;
    }
    process.stderr.write(`Not logged in to ${host}\n`);
    process.exit(1);
  }
  const baseUrl = host === 'github.com' ? undefined : `https://${host}/api/v3`;
  const octokit = new Octokit({ auth: token, ...(baseUrl ? { baseUrl } : {}) });
  const result = await checkSharePublishName(octokit, owner, name);
  if (result.kind === 'ok') {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ type: 'name-check', available: result.available })}\n`,
      );
    } else {
      process.stdout.write(result.available ? 'available\n' : 'taken\n');
    }
    return;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ type: 'error', code: result.kind })}\n`);
    return;
  }
  process.stderr.write(`✗ share name-check failed: ${result.kind}\n`);
  process.exit(1);
}

export function shareNameCheckCommand(getTokenStore: () => Promise<TokenStore>): Command {
  return new Command('name-check')
    .description('Check if owner/name is available on GitHub')
    .requiredOption('--owner <owner>', 'GitHub owner (user or org)')
    .requiredOption('--name <name>', 'Repository name')
    .option('--host <host>', 'GitHub or GitHub Enterprise hostname', 'github.com')
    .option('--json', 'Output JSON', false)
    .action(async (opts: NameCheckOptions) => {
      await runShareNameCheck(opts, await getTokenStore());
    });
}
