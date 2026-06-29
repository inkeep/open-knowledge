import { Command } from 'commander';
import { runDeviceFlow } from '../../auth/device-flow.ts';
import type { TokenStore } from '../../auth/token-store.ts';
import { getOAuthClientId } from '../../github/app-config.ts';
import { validateGitHubHost } from './validate-host.ts';

interface LoginOptions {
  host: string;
  json: boolean;
}

function emit(json: boolean, obj: Record<string, unknown>): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  }
}

async function runLogin(
  opts: LoginOptions,
  tokenStore: TokenStore,
  runDeviceFlowFn = runDeviceFlow,
): Promise<void> {
  const clientId = getOAuthClientId();
  const { host, json } = opts;
  validateGitHubHost(host);

  if (!json) {
    process.stderr.write(`Logging in to ${host}\n`);
  }

  let userCode: string | undefined;
  let verificationUri: string | undefined;

  const result = await runDeviceFlowFn({
    clientId,
    host: host === 'github.com' ? undefined : host,
    onVerification: (v) => {
      userCode = v.userCode;
      verificationUri = v.verificationUri;
      if (json) {
        emit(true, {
          type: 'verification',
          user_code: v.userCode,
          verification_uri: v.verificationUri,
          expires_in: v.expiresIn,
        });
      } else {
        process.stderr.write(`Open: ${v.verificationUri}\nEnter code: ${v.userCode}\n`);
      }
    },
  });

  let login = 'unknown';
  let name: string | undefined;
  let email: string | undefined;
  try {
    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
    const resp = await fetch(`${apiBase}/user`, {
      headers: {
        Authorization: `Bearer ${result.token}`,
        'User-Agent': 'open-knowledge-cli',
        Accept: 'application/vnd.github+json',
      },
    });
    if (resp.ok) {
      const user = (await resp.json()) as { login?: string; name?: string; email?: string };
      login = user.login ?? login;
      name = user.name ?? undefined;
      email = user.email ?? undefined;
    }
  } catch {}

  await tokenStore.set(host, login, result.token, {
    gitProtocol: 'https',
    name,
    email,
  });

  if (json) {
    emit(true, { type: 'complete', host, login });
  } else {
    process.stderr.write(`✓ Logged in as ${login} on ${host}\n`);
  }

  void userCode;
  void verificationUri;
}

export function loginCommand(getTokenStore: () => Promise<TokenStore>): Command {
  return new Command('login')
    .description('Authenticate with GitHub via Device Flow')
    .option('--host <host>', 'GitHub or GitHub Enterprise hostname', 'github.com')
    .option('--json', 'Output JSONL progress events', false)
    .action(async (opts: LoginOptions) => {
      const store = await getTokenStore();
      await runLogin(opts, store);
    });
}
