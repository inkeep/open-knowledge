import { dirname } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { withFileLock, withFileLockSync } from '@inkeep/open-knowledge-core/server';
import lockfile from 'proper-lockfile';
import { getCliLogger } from '../cli-logger.ts';

const ACQUISITION_TIMEOUT_MS = 5000;
const RETRY_INTERVAL_MS = 25;

function retryDelay(error: unknown, deadline: number, configuredTrustPath: string): number {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ELOCKED') throw error;
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    throw Object.assign(
      new Error(
        `Could not acquire Pi trust lock at ${configuredTrustPath}.lock within ${ACQUISITION_TIMEOUT_MS}ms`,
        { cause: error },
      ),
      { code: 'ELOCKED' },
    );
  }
  return Math.min(RETRY_INTERVAL_MS, remaining);
}

function logCanonicalLockWarning(message: string, context: Record<string, unknown>): void {
  getCliLogger()?.warn(context, message);
}

function throwTrustFailures(errors: unknown[], configuredTrustPath: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  const [writeError, releaseError] = errors;
  const writeMessage = writeError instanceof Error ? writeError.message : String(writeError);
  const releaseMessage =
    releaseError instanceof Error ? releaseError.message : String(releaseError);
  throw new AggregateError(
    errors,
    `Pi trust update failed: ${writeMessage}\nReleasing Pi trust lock ${configuredTrustPath}.lock also failed: ${releaseMessage}`,
  );
}

export async function withPiTrustLock(
  configuredTrustPath: string,
  canonicalTrustPath: string,
  fn: () => void,
): Promise<void> {
  await withFileLock(
    `${canonicalTrustPath}.ok.lock`,
    async () => {
      const deadline = performance.now() + ACQUISITION_TIMEOUT_MS;
      let release: () => Promise<void>;
      while (true) {
        try {
          release = await lockfile.lock(dirname(configuredTrustPath), {
            realpath: false,
            lockfilePath: `${configuredTrustPath}.lock`,
          });
          break;
        } catch (error) {
          await setTimeout(retryDelay(error, deadline, configuredTrustPath));
        }
      }
      const errors: unknown[] = [];
      try {
        fn();
      } catch (error) {
        errors.push(error);
      } finally {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      throwTrustFailures(errors, configuredTrustPath);
    },
    { onWarn: logCanonicalLockWarning },
  );
}

export function withPiTrustLockSync(
  configuredTrustPath: string,
  canonicalTrustPath: string,
  fn: () => void,
): void {
  withFileLockSync(
    `${canonicalTrustPath}.ok.lock`,
    () => {
      const deadline = performance.now() + ACQUISITION_TIMEOUT_MS;
      const waitArray = new Int32Array(new SharedArrayBuffer(4));
      let release: () => void;
      while (true) {
        try {
          release = lockfile.lockSync(dirname(configuredTrustPath), {
            realpath: false,
            lockfilePath: `${configuredTrustPath}.lock`,
          });
          break;
        } catch (error) {
          Atomics.wait(waitArray, 0, 0, retryDelay(error, deadline, configuredTrustPath));
        }
      }
      const errors: unknown[] = [];
      try {
        fn();
      } catch (error) {
        errors.push(error);
      } finally {
        try {
          release();
        } catch (error) {
          errors.push(error);
        }
      }
      throwTrustFailures(errors, configuredTrustPath);
    },
    { onWarn: logCanonicalLockWarning },
  );
}
