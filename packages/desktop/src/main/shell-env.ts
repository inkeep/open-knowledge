/**
 * Login-shell `SSH_AUTH_SOCK` harvest for GUI launches.
 *
 * Finder/Dock-launched Electron inherits launchd's environment, whose
 * `SSH_AUTH_SOCK` points at Apple's default ssh-agent — an agent that holds
 * no keys when the user's keys live in an external agent (1Password, Proton
 * Pass, custom `ssh-agent`) exported via `export SSH_AUTH_SOCK=...` in a
 * shell rc file. GUI apps never read rc files, so every git-over-SSH spawn
 * downstream (utility-process server, detached server, desktop-main git)
 * authenticates against the wrong agent and fails with
 * `Permission denied (publickey)` while the same command works in a
 * terminal. Same launchd-impoverishment disease as the PATH handling in
 * `git-spawn-env.ts` / `path-install.ts`, for a different variable.
 *
 * The remedy mirrors `discoverRealInteractivePath`: spawn one interactive
 * login shell, capture the variable, and patch `process.env` before the
 * first consumer reads it. Deliberately scoped to `SSH_AUTH_SOCK` only —
 * harvesting more (PATH especially) has a much larger blast radius and its
 * own established mechanisms.
 */

import { defaultSpawn } from './path-install.ts';

export interface ShellEnvLogger {
  event: (payload: Record<string, unknown> & { event: string }) => void;
}

const DEFAULT_LOGGER: ShellEnvLogger = {
  event: (payload) => console.info('[shell-env]', payload),
};

/**
 * Sentinel wrapping the captured value so rc-file noise (echoes, motd,
 * profiling output) on stdout cannot corrupt it — unlike PATH discovery,
 * which tolerates junk entries, a socket path must come back byte-exact.
 */
const MARK = '<<OK-AUTH-SOCK>>';

export interface HarvestShellAuthSockOpts {
  env?: Record<string, string | undefined>;
  platform?: string;
  spawn?: typeof defaultSpawn;
  logger?: ShellEnvLogger;
  timeoutMs?: number;
}

/**
 * Returns the login shell's `SSH_AUTH_SOCK`, or `null` on any failure
 * (timeout, non-zero exit, empty value, spawn error). Callers must treat
 * `null` as "leave the current value alone" — see `applyHarvestedAuthSock`.
 *
 * Skipped entirely on win32: Windows agents talk over a fixed named pipe,
 * not an env-var-addressed socket.
 */
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
        // Bounded: a broken rc file can produce unbounded stderr.
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
        // Bounded: the raw capture is the only clue to why markers are absent.
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

/**
 * Patches `env.SSH_AUTH_SOCK` with the harvested value. Never downgrades:
 * a `null`/empty harvest or an unchanged value leaves `env` untouched, so a
 * hung rc file or a genuinely agent-less login shell can't strip a working
 * socket from a terminal-launched process. Returns true iff `env` changed.
 */
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
