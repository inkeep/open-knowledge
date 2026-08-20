/**
 * Login-shell PATH capture — the last thing tried before OK offers to download
 * a managed runtime.
 *
 * `mergedEnv` repairs a GUI-launched server's launchd-minimal PATH by
 * appending a static list of well-known tool and package-manager-global
 * directories (`augmentAgentSpawnPath`). No static list can express a version
 * manager that exports no stable directory: nvm keeps the active Node under
 * `~/.nvm/versions/node/<version>/bin` and only a shell function puts it on
 * PATH, and fnm's directory is per-shell and ephemeral
 * (`fnm_multishells/<pid>_<ts>/bin`). On those machines `npx` runs fine in a
 * terminal yet is invisible to a Dock-launched OK, so the launch would offer
 * to download a second Node the user already has.
 *
 * So before that offer, ask the login shell what PATH it has. Capturing the
 * whole PATH rather than just resolving the binary is load-bearing: npm ships
 * `npx` with a `#!/usr/bin/env node` shebang, so an absolute path to `npx`
 * still fails unless its sibling `node` is resolvable too. Appending the
 * directory that holds both fixes the launch and every nested resolution the
 * agent performs afterwards.
 *
 * This does NOT displace static augmentation, for the reasons `git-spawn-path`
 * gives (deterministic, no interaction with user shell configs, identical in
 * dev and packaged builds). It is scoped to the moment those properties stop
 * mattering — a launch that has already failed, where the alternative is a
 * download prompt. One probe per server, timeout-bounded, and never on the
 * happy path.
 *
 * Running the user's shell config is not a new posture: the docked terminal
 * already spawns `$SHELL -l -i`, so anything a profile does here it already
 * does when the user opens a terminal in OK. Note the sibling probes that
 * share this argv shape — `desktop/src/main/claude-readiness.ts` (CLI-on-PATH
 * readiness) and `desktop/src/utility/pty-host.ts` (the docked terminal) —
 * both inherit the bash caveat documented on `interactiveShellProbeArgs`
 * below: under bash, `-l -i` reaches `.bash_profile` but never `.bashrc`.
 */

import { spawn } from 'node:child_process';
import { delimiter } from 'node:path';
import type { PinoLogger } from '../logger.ts';

/** How long the login shell gets to answer before the probe is abandoned. */
const LOGIN_SHELL_PROBE_TIMEOUT_MS = 5_000;

/** Cap on captured stdout — a misbehaving profile must not grow the heap. */
const MAX_PROBE_STDOUT_BYTES = 512 * 1024;

const PATH_BEGIN = '__OK_PATH_BEGIN__';
const PATH_END = '__OK_PATH_END__';

/**
 * Probe script. `printenv PATH` (not `echo $PATH`) is deliberate: it prints
 * the colon-joined value the shell EXPORTS to children, which is what a spawn
 * inherits, and it reads correctly under fish — where `$PATH` is a list that a
 * quoted expansion would join with spaces. The sentinels let the value be
 * recovered from stdout that a login profile has already written to (banners,
 * version-manager chatter).
 */
const PROBE_SCRIPT = `printf %s ${PATH_BEGIN}; printenv PATH; printf %s ${PATH_END}`;

/**
 * `-l -i` matches the docked terminal's own `$SHELL -l -i` (pty-host). Under
 * zsh — macOS's default since Catalina — the startup gates are additive, so
 * one invocation sources `.zprofile` AND `.zshrc`, which is where a version
 * manager initializes itself.
 */
export function loginShellProbeArgs(): readonly string[] {
  return ['-l', '-i', '-c', PROBE_SCRIPT];
}

/**
 * The second capture, for {@link SPLIT_STARTUP_SHELLS}. bash's login and
 * non-login startup branches are mutually EXCLUSIVE: given `-l` it reads
 * `.bash_profile` and never `.bashrc`, no matter that `-i` is also present.
 * Since nvm's installer writes to `.bashrc` by default, the login capture
 * alone misses bash's most common nvm setup entirely — the probe would return
 * a well-formed PATH that simply omits the nvm directory. Dropping `-l` is
 * what reaches that file.
 */
function interactiveShellProbeArgs(): readonly string[] {
  return ['-i', '-c', PROBE_SCRIPT];
}

/**
 * Shells needing both captures because their login and interactive startup
 * files are mutually exclusive (see {@link interactiveShellProbeArgs}). zsh
 * and fish source both sets from one invocation, so they pay for one spawn.
 * `sh` is here because it is bash in POSIX mode on macOS.
 */
const SPLIT_STARTUP_SHELLS = new Set(['bash', 'sh']);

/**
 * Recover the PATH from probe stdout, or null when the sentinels are absent
 * (probe died early, shell refused `-c`) or fenced an empty value.
 *
 * Scans from the LAST begin sentinel so a profile that echoed the command line
 * to stdout doesn't win over the real output.
 */
export function parseLoginShellPath(stdout: string): string | null {
  const begin = stdout.lastIndexOf(PATH_BEGIN);
  if (begin === -1) return null;
  const from = begin + PATH_BEGIN.length;
  const end = stdout.indexOf(PATH_END, from);
  if (end === -1) return null;
  const value = stdout.slice(from, end).trim();
  return value === '' ? null : value;
}

/**
 * Append the login shell's PATH entries to `current`, keeping `current`'s
 * entries first and dropping duplicates. Append-only for the same reason
 * `git-spawn-path` appends: an entry already on PATH keeps winning, so this
 * can only ADD resolutions, never redirect an existing one to a different
 * binary.
 */
export function mergeLoginShellPath(
  current: string | undefined,
  loginShellPath: string,
  delim: string,
): string {
  const entries = (current ?? '').split(delim).filter((e) => e !== '');
  const seen = new Set(entries);
  for (const entry of loginShellPath.split(delim)) {
    if (entry === '' || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return entries.join(delim);
}

/**
 * Put the login shell's PATH first, retaining inherited-only entries behind it.
 * This is deliberately separate from the append-only normal merge: callers use
 * it only after proving the inherited interpreter is incompatible, when keeping
 * that interpreter first would guarantee the launch fails.
 */
export function preferLoginShellPath(
  current: string | undefined,
  loginShellPath: string,
  delim: string,
): string {
  return mergeLoginShellPath(loginShellPath, current ?? '', delim);
}

/** Shells that exist to refuse a session — probing them is pure latency. */
const NON_INTERACTIVE_SHELLS = new Set(['false', 'nologin', 'sync']);

/** Runs the probe and resolves its stdout, or null if it produced no verdict. */
type RunLoginShellProbe = (
  shell: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string | null>;

export interface LoginShellPathDeps {
  log: PinoLogger;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env.SHELL`. */
  shell?: string | undefined;
  timeoutMs?: number;
  /** Test seam — defaults to a real `spawn`. */
  runProbe?: RunLoginShellProbe;
  /** Test seam for the failed-probe backoff clock — defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Spawn the login shell and collect stdout. Never rejects: a spawn that throws
 * (resource exhaustion), errors (ENOENT/EACCES on `$SHELL`), or outlives the
 * timeout (a profile waiting on input) resolves null, which the caller treats
 * as "no verdict" — never as "the user has no npx".
 */
const spawnLoginShellProbe: RunLoginShellProbe = (shell, args, timeoutMs) =>
  new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, [...args], {
        // stdin ignored: a profile that reads from stdin must hit EOF rather
        // than block until the timeout. stderr ignored: profile noise is not
        // ours to surface.
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolvePromise(null);
      return;
    }
    let out = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (out.length >= MAX_PROBE_STDOUT_BYTES) return;
      out += chunk;
    });
    child.on('error', () => finish(null));
    // Read stdout regardless of exit code: a profile that ends with a non-zero
    // status still printed a usable PATH before it got there.
    child.on('close', () => finish(out));
  });

/**
 * How long a probe that produced no verdict is allowed to suppress the next
 * one. Matches `harness-availability.ts`'s TTL for the same reason: repeated
 * shell startups on every failing launch are wasteful, but a permanent cache
 * is worse (see the provider's note on transient failures).
 */
const FAILED_PROBE_RETRY_MS = 60_000;

/** One capture. Null when the shell produced no parsable PATH. */
async function captureShellPath(
  deps: LoginShellPathDeps,
  shell: string,
  args: readonly string[],
  timeoutMs: number,
  runProbe: RunLoginShellProbe,
): Promise<string | null> {
  // `elapsed` is the only thing that separates the failure modes downstream: a
  // value near `timeoutMs` means the shell hung (and the launch it was
  // rescuing paid that latency), where a near-zero one means the shell never
  // ran at all (missing/unexecutable `$SHELL`, resource exhaustion).
  const startedAt = Date.now();
  const stdout = await runProbe(shell, args, timeoutMs).catch(() => null);
  const elapsed = Date.now() - startedAt;
  if (stdout === null) {
    deps.log.debug({ shell, args, elapsed }, '[login-shell-path] probe produced no output');
    return null;
  }
  const value = parseLoginShellPath(stdout);
  if (value === null) {
    deps.log.debug({ shell, args, elapsed }, '[login-shell-path] probe output carried no PATH');
    return null;
  }
  return value;
}

/**
 * A cached login-shell PATH provider. A real answer is memoized for the life
 * of the provider (one per thread manager, so one per server), which keeps a
 * machine with several npx-distributed agents to a single shell startup rather
 * than one per launch.
 *
 * A NON-answer is deliberately not memoized the same way. Null covers two
 * unlike things: structural ("there is no shell to ask" — Windows, no
 * `$SHELL`, a login-refusing shell), which never spawns and never changes, and
 * transient (timeout, `EMFILE`, a half-executed profile), which can succeed on
 * the next try. Caching the transient case forever would let one unlucky
 * timeout disable this fallback for the entire life of a server that is
 * detached and reaped only after 30 idle minutes. So failures expire after
 * {@link FAILED_PROBE_RETRY_MS}; structural skips cost nothing to re-evaluate.
 */
export function createLoginShellPathProvider(
  deps: LoginShellPathDeps,
): () => Promise<string | null> {
  const platform = deps.platform ?? process.platform;
  const shell = deps.shell ?? process.env.SHELL;
  const timeoutMs = deps.timeoutMs ?? LOGIN_SHELL_PROBE_TIMEOUT_MS;
  const runProbe = deps.runProbe ?? spawnLoginShellProbe;
  const now = deps.now ?? Date.now;
  let answer: Promise<string | null> | null = null;
  let retryFailedAfter = 0;

  const probe = async (): Promise<string | null> => {
    if (platform === 'win32') return null;
    if (shell === undefined || shell === '') {
      deps.log.debug({}, '[login-shell-path] no $SHELL; skipping probe');
      return null;
    }
    const base = shell.slice(shell.lastIndexOf('/') + 1);
    if (NON_INTERACTIVE_SHELLS.has(base)) {
      deps.log.debug({ shell }, '[login-shell-path] login-refusing shell; skipping probe');
      return null;
    }
    const login = await captureShellPath(deps, shell, loginShellProbeArgs(), timeoutMs, runProbe);
    if (!SPLIT_STARTUP_SHELLS.has(base)) return login;
    // Union, not fallback: bash's two startup branches hold different
    // directories, and the launch may need either. Merging keeps the login
    // capture's entries first, so precedence follows the profile the user's
    // terminal would have applied last.
    const interactive = await captureShellPath(
      deps,
      shell,
      interactiveShellProbeArgs(),
      timeoutMs,
      runProbe,
    );
    if (login === null) return interactive;
    if (interactive === null) return login;
    return mergeLoginShellPath(login, interactive, delimiter);
  };

  return () => {
    if (answer !== null) return answer;
    if (now() < retryFailedAfter) return Promise.resolve(null);
    const pending = probe().catch(() => null);
    answer = pending;
    void pending.then((value) => {
      if (value !== null) return;
      // No verdict: release the memo so a later launch can try again, but not
      // before the backoff — a shell that hangs must not charge its timeout to
      // every launch in a burst.
      answer = null;
      retryFailedAfter = now() + FAILED_PROBE_RETRY_MS;
    });
    return pending;
  };
}

let sharedProvider: (() => Promise<string | null>) | null = null;

/**
 * The process-wide provider. Both consumers — the launch chain's retry and the
 * harness-availability probe — must agree on what the user's PATH is, or the
 * UI reports an agent as missing that the launch chain can in fact start. One
 * provider also means one shell startup per process rather than one per
 * caller. Tests inject their own provider instead of touching this.
 */
export function getSharedLoginShellPathProvider(log: PinoLogger): () => Promise<string | null> {
  sharedProvider ??= createLoginShellPathProvider({ log });
  return sharedProvider;
}

/**
 * Drop the process-wide memo so the next caller re-probes. A real answer is
 * cached for the life of the server, which is right for a burst of launches
 * and wrong the moment the machine changes underneath it: the user reads
 * "install Node", installs it, and a retry would still be answered from the
 * capture taken before the install. Retry is the one moment where paying for
 * a fresh shell startup buys a different verdict, so it resets first.
 */
export function resetSharedLoginShellPathProvider(): void {
  sharedProvider = null;
}
