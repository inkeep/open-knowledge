import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run `fn` with a fresh `mkdtemp` directory under the OS tmpdir, removing it
 * (recursive, force) when `fn` settles — including on throw, so a failing
 * assertion never leaks the directory.
 *
 * Note: the returned path is NOT realpath'd — on macOS `/var` is a symlink to
 * `/private/var`, so callers comparing against canonicalized paths should
 * `realpath` the directory themselves (matching the existing
 * `realpathSync(mkdtempSync(...))` idiom).
 */
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
