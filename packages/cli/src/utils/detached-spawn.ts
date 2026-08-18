/**
 * Shared recipe for handing a target to the OS (LaunchServices `open`, Finder
 * reveal) as an independent child that survives this CLI process exiting.
 *
 * Every site that launches the desktop app (or any GUI target) from the CLI
 * must use this instead of a bare `spawn`: the packaged CLI wrapper
 * (`Contents/Resources/cli/bin/ok.sh`) sets `ELECTRON_RUN_AS_NODE=1` so the
 * bundled Electron binary acts as a Node host, and LaunchServices propagates
 * the caller's env into the process it spawns — an Electron GUI target that
 * inherits the var boots as a headless Node host with no script and exits
 * immediately. Symptom: the launch line prints but no window appears. The
 * scrub here is what keeps each call site from having to get that right
 * independently.
 */
import {
  type ChildProcess,
  type spawn as NativeSpawn,
  spawn as nativeSpawn,
} from 'node:child_process';
import { withHiddenWindowsConsole } from '@inkeep/open-knowledge-server';

/**
 * Copy `env` minus `ELECTRON_RUN_AS_NODE`. Non-mutating — the input env
 * (typically `process.env`) is left intact for this process. Module-private:
 * the scrub + non-mutation contract is pinned through `spawnDetachedScrubbed`.
 */
function scrubElectronRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

export interface SpawnDetachedScrubbedOptions {
  /** Override for tests — defaults to `node:child_process#spawn`. */
  spawn?: typeof NativeSpawn;
  /** Env to copy + scrub — defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface SpawnDetachedScrubbedAndWaitOptions extends SpawnDetachedScrubbedOptions {
  /** Deadline for receiving the child process's first `spawn` or `error` signal. */
  timeoutMs?: number;
}

export type SpawnDetachedScrubbedOutcome =
  | { ok: true }
  | { ok: false; reason: 'not-installed' | 'timeout' | 'spawn-error' };

function classifySpawnError(err: unknown): SpawnDetachedScrubbedOutcome {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM'
    ? { ok: false, reason: 'not-installed' }
    : { ok: false, reason: 'spawn-error' };
}

function detachedSpawnOptions(env: NodeJS.ProcessEnv): Parameters<typeof nativeSpawn>[2] {
  return withHiddenWindowsConsole({
    detached: true,
    stdio: 'ignore' as const,
    shell: false,
    env: scrubElectronRunAsNode(env),
  });
}

/**
 * Spawn `command` detached (own process group, no stdio ties, `unref()`ed so
 * the CLI's event loop can drain) with `ELECTRON_RUN_AS_NODE` scrubbed from
 * the child env. Returns the child for callers that want a handle; most
 * fire-and-forget.
 */
export function spawnDetachedScrubbed(
  command: string,
  args: readonly string[],
  opts: SpawnDetachedScrubbedOptions = {},
): ChildProcess {
  const spawnFn = opts.spawn ?? nativeSpawn;
  const child = spawnFn(command, [...args], detachedSpawnOptions(opts.env ?? process.env));
  child.unref();
  return child;
}

/**
 * Spawn with the same detached + scrubbed contract, but wait for Node's first
 * process signal before reporting success. OS process creation is an external
 * trust boundary: synchronous throws and asynchronous `error` events are both
 * converted to a typed result so callers cannot print success before the
 * launcher has actually started.
 */
export function spawnDetachedScrubbedAndWait(
  command: string,
  args: readonly string[],
  opts: SpawnDetachedScrubbedAndWaitOptions = {},
): Promise<SpawnDetachedScrubbedOutcome> {
  const spawnFn = opts.spawn ?? nativeSpawn;
  const timeoutMs = opts.timeoutMs ?? 2_000;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: SpawnDetachedScrubbedOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const timer = setTimeout(() => settle({ ok: false, reason: 'timeout' }), timeoutMs);

    try {
      const child = spawnFn(command, [...args], detachedSpawnOptions(opts.env ?? process.env));
      child.once('error', (err) => {
        clearTimeout(timer);
        settle(classifySpawnError(err));
      });
      child.once('spawn', () => {
        clearTimeout(timer);
        settle({ ok: true });
      });
      try {
        child.unref();
      } catch {
        // The child may have exited before its first process signal.
      }
    } catch (err) {
      clearTimeout(timer);
      settle(classifySpawnError(err));
    }
  });
}
