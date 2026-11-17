import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { win32 } from 'node:path';
import { withReceivedProgramLookup } from '@inkeep/open-knowledge-core/util/windows-program-lookup';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';
import { getLogger } from './logger.ts';

function systemDirectory(): string {
  return process.platform === 'win32'
    ? win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    : '/';
}

function personAppOptions(): SpawnOptions {
  return {
    detached: true,
    stdio: 'ignore',
    shell: false,
    cwd: systemDirectory(),
    env: withReceivedProgramLookup(process.env),
  };
}

export interface SpawnDetachedOptions {
  readonly windowsVerbatimArguments?: boolean;
}

export type SpawnDetachedOutcome =
  | { ok: true }
  | { ok: false; reason: 'not-installed' | 'timeout' | 'spawn-error' };

function classifySpawnError(err: unknown): SpawnDetachedOutcome {
  const msg = err instanceof Error ? err.message : String(err);
  return /ENOENT|EACCES|EPERM/.test(msg)
    ? { ok: false, reason: 'not-installed' }
    : { ok: false, reason: 'spawn-error' };
}

export function spawnDetached(
  exec: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
  options: SpawnDetachedOptions = {},
): Promise<SpawnDetachedOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: SpawnDetachedOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const timer = setTimeout(() => settle({ ok: false, reason: 'timeout' }), timeoutMs);
    try {
      const child = nodeSpawn(
        exec,
        [...args],
        withHiddenWindowsConsole({ ...personAppOptions(), ...options }),
      );
      child.once('error', (err) => {
        clearTimeout(timer);
        settle(classifySpawnError(err));
      });
      child.once('spawn', () => {
        if (settled) return;
        try {
          child.unref();
        } catch {}
        clearTimeout(timer);
        settle({ ok: true });
      });
    } catch (err) {
      getLogger('spawn-detached').warn({ err }, 'synchronous spawn throw');
      clearTimeout(timer);
      settle(classifySpawnError(err));
    }
  });
}
