import { runSubprocess } from './subprocess.ts';
import type { AuthEvent } from './types.ts';

export interface RunDeviceFlowOptions {
  cliArgs: readonly string[];
  host?: string;
  timeoutMs?: number;
  onEvent: (event: AuthEvent) => void;
}

export interface RunDeviceFlowController {
  done: Promise<void>;
  cancel(): void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

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
