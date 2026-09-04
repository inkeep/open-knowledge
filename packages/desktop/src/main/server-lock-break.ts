import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function breakServerLockHeldBy(lockDir: string, expected: { pid: number }): boolean {
  const lockPath = join(lockDir, 'server.lock');
  let holderPid: unknown;
  try {
    holderPid = (JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: unknown })?.pid;
  } catch {
    return false;
  }
  if (holderPid !== expected.pid) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}
