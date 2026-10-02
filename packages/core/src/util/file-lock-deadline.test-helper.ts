import { openSync } from 'node:fs';
import { vi } from 'vitest';

export async function arrangeExpiredFileLock(
  lockPath: string,
  schedule: 'stable' | 'disappearing' | 'stale',
  timeoutMs: number,
): Promise<void> {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const startedAt = Date.now();
  let expiredAt: number | undefined;
  vi.spyOn(Date, 'now').mockImplementation(() =>
    expiredAt === undefined ? startedAt : expiredAt++,
  );
  let attempts = 0;

  vi.mocked(openSync).mockImplementation((path, flags, mode) => {
    if (path !== lockPath) return fs.openSync(path, flags, mode);
    if (attempts++ < 2) {
      fs.writeFileSync(lockPath, '');
      if (schedule === 'stale') {
        const modifiedAt = new Date(startedAt - timeoutMs * 3);
        fs.utimesSync(lockPath, modifiedAt, modifiedAt);
      }
    }
    try {
      return fs.openSync(path, flags, mode);
    } catch (error) {
      expiredAt ??= startedAt + timeoutMs + 1;
      if (schedule === 'disappearing') fs.unlinkSync(lockPath);
      throw error;
    }
  });
}
