/**
 * Shared detached-spawn primitive used by `/api/spawn-cursor` and
 * `/api/handoff` handlers. Encapsulates the fire-and-forget "start a process
 * we don't parent" pattern with a uniform timeout race so both call sites
 * share one set of safety properties:
 *
 *   - `shell: false` + argv-array — user-supplied strings can't be
 *     interpolated as shell metacharacters.
 *   - `detached: true` + `stdio: 'ignore'` + `unref()` — OK is not the
 *     parent of the spawned process tree; killing OK doesn't kill it.
 *   - Timeout race — `setTimeout(timeoutMs)` resolves `{ok:false,
 *     reason:'timeout'}` if the child hasn't surfaced its first signal
 *     before then.
 *   - First-signal error classification — `ENOENT/EACCES/EPERM` becomes
 *     `'not-installed'` (semantic), every other error becomes
 *     `'spawn-error'` (catch-all).
 *
 * Callers map `SpawnDetachedOutcome.reason` to RFC 9457 URN tokens at the
 * wire boundary; this helper never constructs problem+json bodies itself.
 */

import { spawn as nodeSpawn } from 'node:child_process';

export type SpawnDetachedOutcome =
  | { ok: true }
  | { ok: false; reason: 'not-installed' | 'timeout' | 'spawn-error' };

function classifySpawnError(err: unknown): SpawnDetachedOutcome {
  const msg = err instanceof Error ? err.message : String(err);
  return /ENOENT|EACCES|EPERM/.test(msg)
    ? { ok: false, reason: 'not-installed' }
    : { ok: false, reason: 'spawn-error' };
}

/**
 * Spawn `exec` with `args` in detached + ignored-stdio mode and resolve as
 * soon as Node has surfaced first error / spawn signal. Never throws —
 * synchronous spawn failures (e.g. invalid argv shape) resolve as
 * `{ok:false, reason:'spawn-error'}` with a warning log.
 */
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
      const child = nodeSpawn(exec, [...args], {
        detached: true,
        stdio: 'ignore',
        shell: false,
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        settle(classifySpawnError(err));
      });
      child.once('spawn', () => {
        if (settled) return;
        try {
          child.unref();
        } catch {
          // Ignore — child already exited.
        }
        clearTimeout(timer);
        settle({ ok: true });
      });
    } catch (err) {
      console.warn('[spawn-detached] synchronous spawn throw:', err);
      clearTimeout(timer);
      settle(classifySpawnError(err));
    }
  });
}
