import { rmSync } from 'node:fs';

const TOLERATED_REMOVAL_ERRNOS: ReadonlySet<string> = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);

const REMOVAL_RETRIES = 3;

export function removeAllDuringTeardown(...targets: string[]): void {
  let firstUntolerated: unknown;
  for (const target of targets) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: REMOVAL_RETRIES });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== undefined && TOLERATED_REMOVAL_ERRNOS.has(code)) {
        console.warn(`[e2e teardown] rm ${target} reported ${code}; leaving it behind`);
        continue;
      }
      firstUntolerated ??= err;
    }
  }
  if (firstUntolerated !== undefined) throw firstUntolerated;
}
