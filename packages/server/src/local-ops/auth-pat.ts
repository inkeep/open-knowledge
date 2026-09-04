import { runSubprocess } from './subprocess.ts';

export interface RunPatOptions {
  cliArgs: readonly string[];
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
  return {
    ok: false,
    host,
    error: result.timedOut ? 'Token validation timed out.' : 'Token validation failed.',
  };
}
