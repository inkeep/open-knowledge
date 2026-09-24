import { expect } from '@playwright/test';

export const RAIL_LAYOUT_SETTLE_TIMEOUT_MS = 10_000;

export interface SettleBudget {
  readonly label: string;
  readonly totalMs: number;
  remainingMs(): number;
}

export interface SettleBudgetOptions {
  timeout: number;
  now?: () => number;
}

export function requirePositiveTimeout(owner: string, timeout: number): void {
  if (!(timeout > 0) || !Number.isFinite(timeout)) {
    throw new Error(
      `${owner} needs a positive, finite timeout; received ${timeout}. ` +
        'Playwright reads 0 and NaN as no deadline.',
    );
  }
}

export function settleBudget(
  label: string,
  { timeout, now = () => performance.now() }: SettleBudgetOptions,
): SettleBudget {
  requirePositiveTimeout(`settle budget "${label}"`, timeout);
  const startedAt = now();
  return {
    label,
    totalMs: timeout,
    remainingMs() {
      const remaining = timeout - (now() - startedAt);
      if (!(remaining > 0)) {
        throw new Error(
          `settle budget "${label}" spent its ${timeout} ms before the next wait on it began`,
        );
      }
      return remaining;
    },
  };
}

export type SettleBound =
  | { timeout: number; budget?: undefined }
  | { budget: SettleBudget; timeout?: undefined };

export type SettledReadingOptions = { reading: string; of: string } & SettleBound;

type SettleAttempt =
  | { readonly kind: 'none' }
  | { readonly kind: 'read' }
  | { readonly kind: 'read-failed'; readonly error: unknown };

function resolveBound(bound: SettleBound): { timeout: number; within: string } {
  if (bound.budget !== undefined) {
    const { label, totalMs } = bound.budget;
    const timeout = bound.budget.remainingMs();
    return {
      timeout,
      within: `within the ${Math.round(timeout)} ms left of settle budget "${label}" (${totalMs} ms)`,
    };
  }
  requirePositiveTimeout('expectSettledReading', bound.timeout);
  return { timeout: bound.timeout, within: `within ${bound.timeout} ms` };
}

export async function expectSettledReading<T>(
  read: () => Promise<T>,
  accept: (value: T) => void,
  options: SettledReadingOptions,
): Promise<void> {
  const { timeout, within } = resolveBound(options);
  const latest: { attempt: SettleAttempt } = { attempt: { kind: 'none' } };
  try {
    await expect(async () => {
      const attempt = await new Promise<T>((resolve) => {
        resolve(read());
      }).then(
        (value) => ({ kind: 'read', value }) as const,
        (error: unknown) => ({ kind: 'read-failed', error }) as const,
      );
      latest.attempt = attempt.kind === 'read' ? { kind: 'read' } : attempt;
      if (attempt.kind === 'read-failed') throw attempt.error;
      accept(attempt.value);
    }).toPass({ timeout });
  } catch (settleFailure) {
    const { attempt } = latest;
    if (attempt.kind === 'read-failed') throw attempt.error;
    if (attempt.kind === 'none') {
      throw new Error(`no ${options.reading} reading completed for ${options.of} ${within}`);
    }
    if (options.budget === undefined) throw settleFailure;
    const reason = settleFailure instanceof Error ? settleFailure.message : String(settleFailure);
    throw new Error(`${options.reading} of ${options.of} never settled ${within}: ${reason}`, {
      cause: settleFailure,
    });
  }
}
