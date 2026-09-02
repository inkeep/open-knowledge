import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';
import { getLogger } from './logger.ts';

const DETACHED_IGNORED_STDIO_OPTIONS: Pick<SpawnOptions, 'detached' | 'stdio' | 'shell'> = {
  detached: true,
  stdio: 'ignore',
  shell: false,
};

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
        withHiddenWindowsConsole(DETACHED_IGNORED_STDIO_OPTIONS),
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
