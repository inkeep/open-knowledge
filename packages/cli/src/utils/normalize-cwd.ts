import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Normalize a project cwd for config/server routing:
 *   1. make it absolute
 *   2. canonicalize symlinks when the path exists
 *
 * If `realpath()` fails (for example because the path does not exist yet),
 * fall back to the absolute path so callers still have a stable cache key.
 * Non-ENOENT failures are warned so operators can diagnose unstable routing.
 */
export async function normalizeCwd(cwd: string): Promise<string> {
  const absolute = resolve(cwd);
  try {
    return await realpath(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[normalize-cwd] realpath failed for ${absolute}: ${message}`);
    }
    return absolute;
  }
}
