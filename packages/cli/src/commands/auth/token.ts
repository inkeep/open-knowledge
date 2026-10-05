import { gitCredentialHostKey, isGitCredentialHost } from '@inkeep/open-knowledge-core';
import password from '@inquirer/password';
import { Command } from 'commander';
import type { TokenStore } from '../../auth/token-store.ts';
import { readTokenFromStdin } from './read-token-stdin.ts';
import { isDeclaredGitHubHost } from './validate-host.ts';

export interface TokenPasteOptions {
  host?: string;
  username?: string;
  json: boolean;
}

export type TokenPasteResult =
  | { type: 'complete'; host: string; login: string }
  | { type: 'error'; message: string };

const USERNAME_HELP =
  'Username git sends with the token (Bitbucket: x-bitbucket-api-token-auth for an API token, x-token-auth for a repository or workspace access token; oauth2 for GitLab; your Gitea username; any non-empty value for Azure DevOps)';

function emit(result: TokenPasteResult, json: boolean): TokenPasteResult {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.type === 'error') {
    process.stderr.write(`${result.message}\n`);
  } else {
    process.stderr.write(`✓ Token stored for ${result.login} on ${result.host}\n`);
  }
  return result;
}

export async function runTokenPaste(
  opts: TokenPasteOptions,
  tokenStore: TokenStore,
  readToken?: () => Promise<string>,
): Promise<TokenPasteResult> {
  const { json } = opts;

  const rawHost = opts.host?.trim() ?? '';
  if (!rawHost) {
    return emit({ type: 'error', message: 'A host is required. Pass --host <host>.' }, json);
  }
  if (!isGitCredentialHost(rawHost)) {
    return emit(
      {
        type: 'error',
        message: `${rawHost} is not a host name. Pass the host git connects to, with an optional :port and no scheme or path, for example git.example.com or git.example.com:8443.`,
      },
      json,
    );
  }
  const host = gitCredentialHostKey(rawHost);
  if (isDeclaredGitHubHost(host)) {
    return emit(
      {
        type: 'error',
        message: `${host} is a GitHub host. Use ok auth pat --host ${host}, which checks the token with GitHub before storing it.`,
      },
      json,
    );
  }

  const username = opts.username?.trim() ?? '';
  if (!username) {
    return emit(
      { type: 'error', message: 'A username is required. Pass --username <username>.' },
      json,
    );
  }

  const getToken = readToken ?? (() => password({ message: 'Enter token:' }));
  const token = await getToken();
  if (!token) {
    return emit({ type: 'error', message: 'No token provided' }, json);
  }

  try {
    await tokenStore.set(host, username, token, { gitProtocol: 'https' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return emit(
      { type: 'error', message: `Could not save the token to the credential store: ${reason}` },
      json,
    );
  }

  return emit({ type: 'complete', host, login: username }, json);
}

export function tokenCommand(getTokenStore: () => Promise<TokenStore>): Command {
  return new Command('token')
    .description('Store an access token for any git host')
    .option('--host <host>', 'Git host to store the token for')
    .option('--username <username>', USERNAME_HELP)
    .option('--json', 'Output JSON', false)
    .option('--token-stdin', 'Read the token from stdin instead of prompting', false)
    .action(
      async (opts: { host?: string; username?: string; json: boolean; tokenStdin?: boolean }) => {
        const readToken = opts.tokenStdin ? readTokenFromStdin : undefined;
        const result = await runTokenPaste(
          { host: opts.host, username: opts.username, json: opts.json },
          await getTokenStore(),
          readToken,
        );
        if (result.type === 'error') process.exit(1);
      },
    );
}
