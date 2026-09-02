import { defaultSpawn } from './path-install.ts';

export interface ShellEnvLogger {
  event: (payload: Record<string, unknown> & { event: string }) => void;
}

const DEFAULT_LOGGER: ShellEnvLogger = {
  event: (payload) => console.info('[shell-env]', payload),
};

const MARK = '<<OK-AUTH-SOCK>>';

export interface HarvestShellAuthSockOpts {
  env?: Record<string, string | undefined>;
  platform?: string;
  spawn?: typeof defaultSpawn;
  logger?: ShellEnvLogger;
  timeoutMs?: number;
}

export async function harvestShellAuthSock(
  opts: HarvestShellAuthSockOpts = {},
): Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') return null;
  const env = opts.env ?? process.env;
  const shell = env.SHELL ?? (platform === 'linux' ? '/bin/bash' : '/bin/zsh');
  const spawn = opts.spawn ?? defaultSpawn;
  const logger = opts.logger ?? DEFAULT_LOGGER;
  try {
    // biome-ignore lint/plugin/require-windowshide-on-spawn: injected command-runner seam; defaultSpawn owns child_process options
    const result = await spawn(shell, ['-ilc', `printf %s "${MARK}$SSH_AUTH_SOCK${MARK}"`], {
      timeoutMs: opts.timeoutMs ?? 2000,
      env,
    });
    if (result.code !== 0 || result.timedOut) {
      logger.event({
        event: 'shell-authsock-harvest-failed',
        shell,
        code: result.code,
        timedOut: result.timedOut ?? false,
        stderr: result.stderr.slice(0, 300),
      });
      return null;
    }
    const first = result.stdout.indexOf(MARK);
    const last = result.stdout.lastIndexOf(MARK);
    if (first === -1 || last <= first) {
      logger.event({
        event: 'shell-authsock-harvest-failed',
        shell,
        reason: 'marker-missing',
        stdout: result.stdout.slice(0, 300),
      });
      return null;
    }
    const value = result.stdout.slice(first + MARK.length, last).trim();
    return value === '' ? null : value;
  } catch (err) {
    logger.event({
      event: 'shell-authsock-harvest-failed',
      shell,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function applyHarvestedAuthSock(
  env: Record<string, string | undefined>,
  harvested: string | null,
  logger: ShellEnvLogger = DEFAULT_LOGGER,
): boolean {
  if (harvested === null || harvested === '' || harvested === env.SSH_AUTH_SOCK) {
    return false;
  }
  const previous = env.SSH_AUTH_SOCK ?? null;
  env.SSH_AUTH_SOCK = harvested;
  logger.event({ event: 'shell-authsock-harvested', from: previous, to: harvested });
  return true;
}
