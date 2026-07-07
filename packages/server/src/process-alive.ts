/**
 * Check whether a process with the given pid is still alive on this host.
 *
 * `process.kill(pid, 0)` sends no signal but throws if the pid does not exist.
 * EPERM means the process exists but we lack permission to signal it — still alive.
 *
 * Pure liveness probe — no security/range validation. Callers MUST validate
 * pids that originate from lock files via `isValidLockPid` before passing
 * them here, otherwise a tampered lock with `pid: 0` (process group) or
 * `pid: 1` (init/launchd) reads as "alive" and steers kill code paths.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

/**
 * Range-check a value parsed from a `*.lock` file's `pid` field. The lock
 * format intentionally accepts our OWN pid (idempotent re-acquire path), so
 * this validator only rejects the structural-impossibility cases:
 *   - PID `0`  — `process.kill(0, sig)` signals every process in our process
 *                group (POSIX), which is catastrophic if such a value ever
 *                steers signal-sending code;
 *   - PID `1`  — init/launchd; on macOS `process.kill(1, 0)` returns EPERM
 *                ("alive"), so a hostile-lock kill path would attempt SIGTERM/
 *                SIGKILL on launchd before EPERM stops the actual delivery;
 *   - negative values — `kill(-pgid, sig)` is a process-group signal under
 *                POSIX; never valid in a lock file;
 *   - non-integer / NaN / Infinity — never a real PID.
 *
 * Linux PIDs cap at `kernel.pid_max` (default 2^22 = 4_194_304); macOS at
 * 2^31 - 1 by recent kernels. We use 2^31 - 1 as the conservative ceiling so
 * lock files written on one OS still parse on another. Anything larger is a
 * sign of corruption or tampering.
 *
 * Callers that need the additional "do not signal self" guard (e.g. the
 * desktop auto-kill collision-recovery code) MUST add a separate
 * `pid !== process.pid` check at the signal-send site.
 *
 * Lock files live under `<contentDir>/.ok/`, which on shared volumes / `/tmp`
 * projects / multi-user hosts is writable by processes other than the lock
 * holder. Without this validator a tampered or corrupt lock could cause
 * collision-recovery code to send signals to PID 0/1/-N etc.
 */
export function isValidLockPid(value: unknown): value is number {
  if (typeof value !== 'number') return false;
  if (!Number.isInteger(value)) return false;
  if (value < 2) return false;
  if (value > 0x7fffffff) return false;
  return true;
}
