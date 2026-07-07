/**
 * `open-knowledge share owners` — list GitHub owners (user + orgs filtered by
 * can_create_repository) eligible to host a new repo via the Publish-to-GitHub
 * wizard. JSON-only output; emits exactly one event line on stdout and exits
 * 0 so the server-side subprocess wrapper can parse without method ambiguity.
 *
 * Events (one of):
 *   { type: 'owners', owners: [{ login, kind: 'user' | 'org', avatarUrl? }, ...] }
 *   { type: 'error', code: 'auth-required' | 'network' }
 */

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

/**
 * Pull owners eligible to create a new repo: the authenticated user first,
 * then every active org membership where the user is either an org admin
 * OR `permissions.can_create_repository` is explicitly `true`. Pre-filtering
 * at this layer avoids dead-ended POST /api/share/publish submits per owner
 * eligibility. Pagination is bounded — Octokit's iterator pages 100 at a
 * time; few users belong to >100 orgs.
 *
 * Why two signals instead of one: the `permissions` block on a membership
 * is only included when the OAuth token has `admin:org` scope. With the
 * default `repo` scope used by the publish flow, `permissions` is absent
 * even for orgs the user can create repos in — including admin-role orgs.
 * Falling back to `role === 'admin'` recovers those orgs without widening
 * the token's scope (admins can always create repos in their own org).
 * Pure members of orgs without the `permissions` block stay filtered out —
 * we can't confirm they have create permission without the scope upgrade,
 * and surfacing them would create the dead-end this filter exists to avoid.
 *
 * `octokit` is parameterized so tests inject a fake without hitting the
 * network. The real Octokit instance is built inside `runShareOwners`.
 */
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
    // 401 from GitHub when the token is invalid/expired. We surface
    // `auth-required` so the wizard can route through the existing
    // Device-Flow modal rather than the generic network toast.
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
