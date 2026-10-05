import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LARGEST_UNIX_SOCKET_PATH_BYTES = 108;

export async function withTempDir<T>(
  prefix: string,
  fn: (dir: string) => T | Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function createTempDirFactory(
  registerCleanup: (cleanup: () => Promise<void>) => unknown,
): (prefix: string) => string {
  const paths: string[] = [];
  registerCleanup(async () => {
    const results = await Promise.allSettled(
      paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Temp dir cleanup failed');
  });
  return (prefix) => {
    const path = mkdtempSync(join(tmpdir(), prefix));
    paths.push(path);
    return path;
  };
}

export function createSocketPathOverflowingTempDir(parent: string): string {
  let dir = join(parent, 'temporary-files-with-a-long-inherited-path');
  while (Buffer.byteLength(dir) <= LARGEST_UNIX_SOCKET_PATH_BYTES) {
    dir = join(dir, 'nested-directory-beyond-unix-socket-path-capacity');
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}
