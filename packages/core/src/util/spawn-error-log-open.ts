import { fchmodSync, openSync, statSync, writeSync } from 'node:fs';
import { formatSpawnAttemptHeader, spawnErrorLogOpenMode } from '../constants/lifecycle.ts';

export function openSpawnErrorLog(path: string, spawningPid: number): number {
  let existingSize: number | undefined;
  try {
    existingSize = statSync(path).size;
  } catch {
    existingSize = undefined;
  }
  const fd = openSync(path, spawnErrorLogOpenMode(existingSize), 0o600);
  try {
    fchmodSync(fd, 0o600);
  } catch {}
  try {
    writeSync(fd, formatSpawnAttemptHeader(new Date(), spawningPid));
  } catch {}
  return fd;
}
