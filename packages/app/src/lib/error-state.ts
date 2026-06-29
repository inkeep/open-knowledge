
import { toast as sonnerToast } from 'sonner';

export function resolveErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export async function runWithErrorStatePure(
  fn: () => Promise<void>,
  fallback: string,
  setError: (msg: string | null) => void,
  logPrefix = 'action',
): Promise<void> {
  try {
    setError(null);
    await fn();
  } catch (err) {
    console.error(`[${logPrefix}] action failed:`, err);
    setError(resolveErrorMessage(err, fallback));
  }
}

export async function runWithToast(
  fn: () => Promise<void>,
  fallback: string,
  toastApi: { error(msg: string): void } = sonnerToast,
  logPrefix = 'action',
): Promise<void> {
  await runWithErrorStatePure(
    fn,
    fallback,
    (msg) => {
      if (msg !== null) toastApi.error(msg);
    },
    logPrefix,
  );
}
