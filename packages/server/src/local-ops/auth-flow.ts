/**
 * GitHub Device Flow runner — spawns `<cli> auth login --json --host <host>`
 * and emits structured events to a callback. Used by both the HTTP relay
 * (api-extension.ts) and the desktop-main IPC handler (Navigator window has
 * no backing API server).
 *
 * The CLI emits one of:
 *   {type:'verification', user_code, verification_uri, expires_in}
 *   {type:'complete', host, login}
 *   {type:'error', message}
 *
 * On clean exit without a terminal event, this runner synthesizes a
 * `complete` so the caller never hangs on a silent exit (the device-flow
 * subprocess sometimes returns 0 after writing the token to the keychain
 * without emitting `complete` on older builds).
 */

import { runSubprocess } from './subprocess.ts';
import type { AuthEvent } from './types.ts';

export interface RunDeviceFlowOptions {
  /** Command + base argv prefix; e.g. `['open-knowledge']` or `[process.execPath, scriptPath]`. */
  cliArgs: readonly string[];
  /** GitHub host. Defaults to `'github.com'`. */
  host?: string;
  /** Wall-clock subprocess timeout. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** Called for every parsed event. */
  onEvent: (event: AuthEvent) => void;
}

export interface RunDeviceFlowController {
  /** Resolves once the subprocess has exited and the final synthesized event (if any) is emitted. */
  done: Promise<void>;
  /** SIGTERM the child. */
  cancel(): void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Heuristic — return `true` when the parsed JSON matches the shape of one
 * of the expected `AuthEvent` variants. Non-event lines (the CLI sometimes
 * writes keychain probe info on stdout in older builds) are ignored.
 */
function asAuthEvent(parsed: Record<string, unknown>): AuthEvent | null {
  const type = parsed.type;
  if (type === 'verification') {
    if (
      typeof parsed.user_code === 'string' &&
      typeof parsed.verification_uri === 'string' &&
      typeof parsed.expires_in === 'number'
    ) {
      return {
        type: 'verification',
        user_code: parsed.user_code,
        verification_uri: parsed.verification_uri,
        expires_in: parsed.expires_in,
      };
    }
    return null;
  }
  if (type === 'complete') {
    return {
      type: 'complete',
      host: typeof parsed.host === 'string' ? parsed.host : '',
      login: typeof parsed.login === 'string' ? parsed.login : '',
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      email: typeof parsed.email === 'string' ? parsed.email : undefined,
      avatarUrl: typeof parsed.avatarUrl === 'string' ? parsed.avatarUrl : undefined,
    };
  }
  if (type === 'error') {
    return {
      type: 'error',
      message: typeof parsed.message === 'string' ? parsed.message : 'Unknown error',
    };
  }
  return null;
}

export function runDeviceFlowSubprocess(opts: RunDeviceFlowOptions): RunDeviceFlowController {
  const host = opts.host ?? 'github.com';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let sawTerminal = false;

  const proc = runSubprocess({
    cliArgs: opts.cliArgs,
    trailingArgs: ['auth', 'login', '--json', '--host', host],
    timeoutMs,
    onLine: ({ parsed }) => {
      if (!parsed) return;
      const event = asAuthEvent(parsed);
      if (!event) return;
      if (event.type === 'complete' || event.type === 'error') {
        sawTerminal = true;
      }
      opts.onEvent(event);
    },
  });

  const done = proc.done.then((result) => {
    if (sawTerminal) return;
    if (result.code === 0) {
      // CLI exited cleanly without a terminal event — synthesize one so
      // the caller's stream resolves. Login name will be filled in by the
      // next /api/local-op/auth/status poll on the client side.
      opts.onEvent({ type: 'complete', host, login: '' });
    } else {
      opts.onEvent({
        type: 'error',
        message: result.timedOut
          ? 'Sign-in timed out'
          : `auth login exited with code ${result.code ?? -1}`,
      });
    }
  });

  return { done, cancel: proc.cancel };
}
