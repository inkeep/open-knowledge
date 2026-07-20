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
  const child = spawnFn(
    command,
    [...args],
    withHiddenWindowsConsole({
      detached: true,
      stdio: 'ignore' as const,
      env: scrubElectronRunAsNode(opts.env ?? process.env),
    }),
  );
  child.unref();
  return child;
}
