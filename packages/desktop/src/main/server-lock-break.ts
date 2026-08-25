import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Break a project's `server.lock` on behalf of a caller that has decided its
 * holder is both unkillable and not serving.
 *
 * Its own module so the desktop's window-manager wiring and the tests exercise
 * the SAME function. `index.ts` bootstraps Electron at module scope and cannot
 * be imported from Vitest, so an inline arrow there can only ever be tested by
 * hand-copying it — which pins the copy, not the code that ships.
 *
 * Read-compare-unlink, mirroring `process-lock.ts`'s `registerExitUnlink`. The
 * caller's verdict is about a specific holder and a health probe stands between
 * that verdict and this call, so a successor that acquired the lock meanwhile
 * must keep it.
 *
 * Returns whether this call removed the lock, so the caller can report what
 * actually happened rather than what it intended. Never throws: it is reached
 * only on a recovery path whose whole purpose is to un-wedge a project, and a
 * read-only directory or a held file there must degrade to "could not break it"
 * rather than replace a stuck project with a crashed one.
 */
export function breakServerLockHeldBy(lockDir: string, expected: { pid: number }): boolean {
  const lockPath = join(lockDir, 'server.lock');
  let holderPid: unknown;
  try {
    holderPid = (JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: unknown })?.pid;
  } catch {
    // Gone or unparseable. Gone is the end state we wanted; unparseable is not a
    // claim we can confirm is the one we judged, and `runClean` already prunes
    // corrupt locks on boot. Either way, not ours to break.
    return false;
  }
  if (holderPid !== expected.pid) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    // ENOENT means someone released it between the read and here, which is the
    // end state we wanted but not a removal WE performed. Anything else is a
    // real IO failure the caller has to survive.
    return false;
  }
}
