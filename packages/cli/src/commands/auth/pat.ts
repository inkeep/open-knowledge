import { originGitHubHost } from '@inkeep/open-knowledge-server';
import password from '@inquirer/password';
import { Octokit } from '@octokit/rest';
import { Command } from 'commander';
import type { TokenStore } from '../../auth/token-store.ts';
import { validateGitHubHost } from './validate-host.ts';

interface PatOptions {
  host: string;
  json: boolean;
}

async function runPat(
  opts: PatOptions,
  tokenStore: TokenStore,
  readToken?: () => Promise<string>,
): Promise<void> {
  const { host, json } = opts;
  validateGitHubHost(host);

  const getToken = readToken ?? (() => password({ message: 'Enter PAT:' }));

  const token = await getToken();
  if (!token) {
    process.stderr.write('No token provided\n');
    process.exit(1);
  }

  const baseUrl = host === 'github.com' ? undefined : `https://${host}/api/v3`;
  const octokit = new Octokit({ auth: token, ...(baseUrl ? { baseUrl } : {}) });

  let login = 'unknown';
  let name: string | undefined;
  let email: string | undefined;
  try {
    const { data } = await octokit.users.getAuthenticated();
    login = data.login;
    name = data.name ?? undefined;
    email = data.email ?? undefined;
  } catch {
    process.stderr.write('Token validation failed\n');
    process.exit(1);
  }

  await tokenStore.set(host, login, token, { gitProtocol: 'https', name, email });

  if (json) {
    process.stdout.write(`${JSON.stringify({ type: 'complete', host, login })}\n`);
  } else {
    process.stderr.write(`✓ PAT stored for ${login} on ${host}\n`);
  }
}

export function patCommand(getTokenStore: () => Promise<TokenStore>): Command {
  return new Command('pat')
    .description('Store a Personal Access Token')
    .option(
      '--host <host>',
      'GitHub or GitHub Enterprise hostname (default: workspace origin host)',
    )
    .option('--json', 'Output JSON', false)
    .action(async (opts: Omit<PatOptions, 'host'> & { host?: string }) => {
      const host = opts.host ?? originGitHubHost(process.cwd());
      await runPat({ ...opts, host }, await getTokenStore());
    });
}
