import { Octokit } from '@octokit/rest';
import { Command } from 'commander';
import type { TokenStore } from '../../auth/token-store.ts';
import { resolveReposToken } from '../auth/repos.ts';
import { validateGitHubHost } from '../auth/validate-host.ts';

interface OwnersOptions {
  host: string;
  json: boolean;
}

export interface ShareOwner {
  login: string;
  kind: 'user' | 'org';
  avatarUrl?: string;
}

type OwnerListResult =
  | { kind: 'ok'; owners: ShareOwner[] }
  | { kind: 'auth-required' }
  | { kind: 'network' };

export async function listShareOwners(octokit: Octokit): Promise<OwnerListResult> {
  try {
    const owners: ShareOwner[] = [];
    const me = await octokit.users.getAuthenticated();
    owners.push({ login: me.data.login, kind: 'user', avatarUrl: me.data.avatar_url });
    for await (const page of octokit.paginate.iterator(
      octokit.orgs.listMembershipsForAuthenticatedUser,
      { state: 'active', per_page: 100 },
    )) {
      for (const membership of page.data) {
        const canCreate =
          membership.permissions?.can_create_repository === true || membership.role === 'admin';
        if (canCreate) {
          owners.push({
            login: membership.organization.login,
            kind: 'org',
            avatarUrl: membership.organization.avatar_url ?? undefined,
          });
        }
      }
    }
    return { kind: 'ok', owners };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) return { kind: 'auth-required' };
    return { kind: 'network' };
  }
}

async function runShareOwners(opts: OwnersOptions, tokenStore: TokenStore): Promise<void> {
  const { host, json } = opts;
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

  const result = await listShareOwners(octokit);
  if (result.kind === 'ok') {
    if (json) {
      process.stdout.write(`${JSON.stringify({ type: 'owners', owners: result.owners })}\n`);
    } else {
      for (const owner of result.owners) {
        process.stdout.write(`${owner.kind}\t${owner.login}\n`);
      }
    }
    return;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ type: 'error', code: result.kind })}\n`);
    return;
  }
  process.stderr.write(`✗ share owners failed: ${result.kind}\n`);
  process.exit(1);
}

export function shareOwnersCommand(getTokenStore: () => Promise<TokenStore>): Command {
  return new Command('owners')
    .description('List GitHub owners eligible to host a new repository')
    .option('--host <host>', 'GitHub or GitHub Enterprise hostname', 'github.com')
    .option('--json', 'Output JSON', false)
    .action(async (opts: OwnersOptions) => {
      await runShareOwners(opts, await getTokenStore());
    });
}
