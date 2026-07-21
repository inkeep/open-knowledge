/**
 * Personal Access Token runner — spawns `<cli> auth pat --json --host <host>
 * --token-stdin`, writes the token to the child's stdin (never argv/env), and
 * resolves with the stored identity or an error.
 *
 * The enterprise sign-in path: the OAuth device flow only works on github.com
 * (OpenKnowledge's OAuth app isn't registered on arbitrary GHES instances), so
 * a GHES host authenticates by storing a PAT instead. On success the CLI emits
 * `{type:'complete', host, login}`; on failure it writes the reason to stderr
 * (via describeAuthFailure) and exits non-zero, which we surface verbatim.
 */

import { runSubprocess } from './subprocess.ts';

export interface RunPatOptions {
  /** Command + base argv prefix; e.g. `['open-knowledge']` or `[process.execPath, scriptPath]`. */
  cliArgs: readonly string[];
  /** GitHub host. Defaults to `'github.com'`. */
  host?: string;
  /** The Personal Access Token to validate + store. */
  token: string;
  /** Wall-clock subprocess timeout. Defaults to 30s. */
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
  // The CLI emits a bounded {type:'error'} on --json failures, so reaching here
  // means an unexpected exit (crash / killed). Keep the wire message generic and
  // bounded — raw stderr can carry filesystem paths.
  return {
    ok: false,
    host,
    error: result.timedOut ? 'Token validation timed out.' : 'Token validation failed.',
  };
}
