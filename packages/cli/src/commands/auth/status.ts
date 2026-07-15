import { originGitHubHost } from '@inkeep/open-knowledge-server';
import { Octokit } from '@octokit/rest';
import { Command } from 'commander';
import { detectGh } from '../../auth/gh-detect.ts';
import type { TokenStore } from '../../auth/token-store.ts';
import { validateGitHubHost } from './validate-host.ts';

interface StatusOptions {
  host: string;
  json: boolean;
}

type ResolvedStatusSource = { tier: 'A' | 'B' | 'C'; token: string } | { tier: 'none' };

/**
 * Pick the credential source for an `auth status` call: gh delegation first,
 * stored token second, none third. `_detectGhFn` is injectable for tests so
 * we can drive the cascade without spawning `gh`.
 */
export async function resolveStatusSource(
  host: string,
  tokenStore: TokenStore,
  _detectGhFn: (host?: string) => ReturnType<typeof detectGh> = detectGh,
): Promise<ResolvedStatusSource> {
  const gh = _detectGhFn(host);
  if (gh.available && gh.token) return { tier: 'A', token: gh.token };
  const entry = await tokenStore.get(host);
  if (entry == null) return { tier: 'none' };
  return { tier: entry.gitProtocol === 'ssh' ? 'C' : 'B', token: entry.token };
}

/**
 * Status outcomes that map to the `--json` payload. Pure shape (no IO) so the
 * payload builder below can be unit-tested without spawning gh or hitting the
 * GitHub API.
 */
export type StatusOutcome =
  | { authenticated: false }
  | { authenticated: false; error: string }
  | {
      authenticated: true;
      tier: 'A' | 'B' | 'C';
      login: string;
      name: string | null;
      email: string | null;
    };

/**
 * Build the `auth status --json` payload. `backend` names the active token
 * storage mechanism (`keyring` | `file`) so callers can confirm where the
 * credential lives — the Linux CLI e2e smoke asserts the headless fallback
 * resolved to `file` even with no token stored.
 */
export function buildStatusPayload(
  host: string,
  backend: TokenStore['backend'],
  outcome: StatusOutcome,
): Record<string, unknown> {
  return { type: 'status', host, backend, ...outcome };
}

async function runStatus(opts: StatusOptions, tokenStore: TokenStore): Promise<void> {
  const { host, json } = opts;
  validateGitHubHost(host);

  const backend = tokenStore.backend;
  const source = await resolveStatusSource(host, tokenStore);

  if (source.tier === 'none') {
    if (json) {
      process.stdout.write(
        `${JSON.stringify(buildStatusPayload(host, backend, { authenticated: false }))}\n`,
      );
    } else {
      process.stderr.write(`Not logged in to ${host}\n`);
    }
    process.exit(1);
  }

  const baseUrl = host === 'github.com' ? undefined : `https://${host}/api/v3`;
  const octokit = new Octokit({ auth: source.token, ...(baseUrl ? { baseUrl } : {}) });

  try {
    const { data } = await octokit.users.getAuthenticated();
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          buildStatusPayload(host, backend, {
            authenticated: true,
            tier: source.tier,
            login: data.login,
            name: data.name,
            email: data.email,
          }),
        )}\n`,
      );
    } else {
      process.stderr.write(`✓ Logged in as ${data.login} on ${host}\n`);
    }
  } catch {
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          buildStatusPayload(host, backend, { authenticated: false, error: 'token invalid' }),
        )}\n`,
      );
    } else {
      process.stderr.write(`✗ Token invalid for ${host}\n`);
    }
    process.exit(1);
  }
}

export function statusCommand(getTokenStore: () => Promise<TokenStore>): Command {
  return new Command('status')
    .description('Show authentication status')
    .option(
      '--host <host>',
      'GitHub or GitHub Enterprise hostname (default: workspace origin host)',
    )
    .option('--json', 'Output JSON', false)
    .action(async (opts: Omit<StatusOptions, 'host'> & { host?: string }) => {
      const host = opts.host ?? originGitHubHost(process.cwd());
      await runStatus({ ...opts, host }, await getTokenStore());
    });
}
