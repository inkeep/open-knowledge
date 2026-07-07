/**
 * `open-knowledge share name-check` — probe whether `<owner>/<name>` already
 * exists on GitHub so the wizard can surface inline conflicts before submit
 *. 200 OK → name is taken; 404 → name is available; anything else is
 * network.
 *
 * Events:
 *   { type: 'name-check', available: boolean }
 *   { type: 'error', code: 'auth-required' | 'network' }
 */

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

/**
 * Issue `GET /repos/{owner}/{name}` against the authenticated Octokit. The
 * SDK returns the typed body on 200 and throws `RequestError` with `.status`
 * on any non-2xx, so we branch on `status === 404` (available) vs anything
 * else (taken / transient). Auth failures (401) surface as `auth-required`
 * so the wizard re-prompts; 403s without SSO context fall through to
 * `network`.
 */
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
