import { stderrDetailSuffix } from './clone-error-classify.ts';
import {
  LOCAL_OP_AUTH_SUBPROCESS_TIMEOUT_MS,
  type LocalOpCliInvocation,
  runSubprocess,
} from './subprocess.ts';
import type { LocalOpSubprocessLifetime } from './subprocess-lifetime.ts';

export interface RunAuthTokenOptions extends LocalOpCliInvocation {
  lifetime?: LocalOpSubprocessLifetime;
  host: string;
  username: string;
  token: string;
  timeoutMs?: number;
}

export type RunAuthTokenResult =
  | { ok: true; host: string; login: string }
  | { ok: false; host: string; error: string };

export async function runAuthTokenSubprocess(
  opts: RunAuthTokenOptions,
): Promise<RunAuthTokenResult> {
  const host = opts.host;
  let terminal: RunAuthTokenResult | null = null;

  const proc = runSubprocess({
    lifetime: opts.lifetime,
    cliArgs: opts.cliArgs,
    cliEnv: opts.cliEnv,
    trailingArgs: [
      'auth',
      'token',
      '--json',
      '--host',
      host,
      '--username',
      opts.username,
      '--token-stdin',
    ],
    stdinData: opts.token,
    timeoutMs: opts.timeoutMs ?? LOCAL_OP_AUTH_SUBPROCESS_TIMEOUT_MS,
    onLine: ({ parsed }) => {
      if (!parsed) return;
      if (parsed.type === 'complete') {
        terminal = {
          ok: true,
          host: typeof parsed.host === 'string' ? parsed.host : host,
          login: typeof parsed.login === 'string' ? parsed.login : '',
        };
      } else if (parsed.type === 'error') {
        terminal = {
          ok: false,
          host,
          error: typeof parsed.message === 'string' ? parsed.message : 'Storing the token failed',
        };
      }
    },
  });

  const result = await proc.done;
  if (terminal) return terminal;
  if (result.timedOut) return { ok: false, host, error: 'Storing the token timed out.' };
  return {
    ok: false,
    host,
    error: `Storing the token failed.${stderrDetailSuffix(result.stderr, [opts.token, opts.token.trim()])}`,
  };
}
