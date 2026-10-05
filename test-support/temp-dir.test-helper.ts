import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
