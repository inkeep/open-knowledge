import { rmSync } from 'node:fs';

export function removeTempDirBestEffort(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {}
}
