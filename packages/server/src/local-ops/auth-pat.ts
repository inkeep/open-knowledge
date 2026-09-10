import { stderrDetailSuffix } from './clone-error-classify.ts';
import { type LocalOpCliInvocation, runSubprocess } from './subprocess.ts';

export interface RunPatOptions extends LocalOpCliInvocation {
  host?: string;
  token: string;
  timeoutMs?: number;
}

export type RunPatResult =
  | { ok: true; host: string; login: string }
  | { ok: false; host: string; error: string };

const DEFAULT_TIMEOUT_MS = 30_000;

export async function runPatSubprocess(opts: RunPatOptions): Promise<RunPatResult> {
  const host = opts.host ?? 'github.com';
  let terminal: RunPatResult | null = null;

  const proc = runSubprocess({
    cliArgs: opts.cliArgs,
    cliEnv: opts.cliEnv,
    trailingArgs: ['auth', 'pat', '--json', '--host', host, '--token-stdin'],
    stdinData: opts.token,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
          error: typeof parsed.message === 'string' ? parsed.message : 'Token validation failed',
        };
      }
    },
  });

  const result = await proc.done;
  if (terminal) return terminal;
  if (result.timedOut) return { ok: false, host, error: 'Token validation timed out.' };
  return { ok: false, host, error: `Token validation failed.${stderrDetailSuffix(result.stderr)}` };
}
