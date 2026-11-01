import { fchmodSync, mkdirSync, openSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatSpawnAttemptHeader, spawnErrorLogOpenMode } from '../constants/lifecycle.ts';

export function openSpawnErrorLog(path: string, spawningPid: number): number {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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
