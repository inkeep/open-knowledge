import { rmSync } from 'node:fs';

/**
 * Removes a test-owned OS temp directory without ever throwing.
 *
 * `rmSync`'s `force: true` suppresses only `ENOENT` — a permission error, or a
 * handle the OS still holds, still throws. Directories that hosted a real child
 * process (a node-pty shell, a packaged Electron app) hit that routinely on
 * Windows, which reports `EPERM` for a short window after the child exits
 * because the handle is not released synchronously with process exit.
 *
 * Teardown of such a directory is housekeeping, never a verdict: a throw here
 * would overturn assertions that already passed. Ride out the transient window
 * with bounded retries (`rmSync` retries EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM),
 * then give up silently — the path is an OS temp directory and the OS reclaims
 * it.
 */
export function removeTempDirBestEffort(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Best-effort by contract: the caller's verdict must not depend on this.
  }
}
