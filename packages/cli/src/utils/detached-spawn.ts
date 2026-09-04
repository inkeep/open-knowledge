import {
  type ChildProcess,
  type spawn as NativeSpawn,
  spawn as nativeSpawn,
} from 'node:child_process';
import { withHiddenWindowsConsole } from '@inkeep/open-knowledge-server';

function scrubElectronRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

export interface SpawnDetachedScrubbedOptions {
  spawn?: typeof NativeSpawn;
  env?: NodeJS.ProcessEnv;
}

export interface SpawnDetachedScrubbedAndWaitOptions extends SpawnDetachedScrubbedOptions {
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
      } catch {}
    } catch (err) {
      clearTimeout(timer);
      settle(classifySpawnError(err));
    }
  });
}
