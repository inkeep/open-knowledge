import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

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
