import { TestRunner } from 'vitest';

const DEFAULT_POLL_MS = 25;
const DEFAULT_REPORT_RESERVE_MS = 1_000;

const realSetTimeout = globalThis.setTimeout;
const realNow = Date.now;

export interface WaitWithinTestBudgetOptions {
  timeoutMs: number;
  pollMs?: number;
  reserveMs?: number;
}

export function remainingTestBudgetMs(nowMs: number = realNow()): number | undefined {
  const currentTest = TestRunner.getCurrentTest();
  if (currentTest === undefined || currentTest.concurrent === true) return undefined;
  const result = currentTest.result;
  if (result?.startTime === undefined) return undefined;
  const timeout = currentTest.timeout;
  if (!Number.isFinite(timeout) || timeout <= 0) return undefined;
  if ((result.retryCount ?? 0) > 0 || (result.repeatCount ?? 0) > 0) return undefined;
  return timeout - (nowMs - result.startTime);
}

function budgetNote(
  budgetMs: number | undefined,
  grantedMs: number,
  timeoutMs: number,
  reserveMs: number,
): string {
  if (budgetMs === undefined) {
    return ", granted the full request: the test's own remaining budget could not be read";
  }
  if (grantedMs >= timeoutMs) return '';
  if (grantedMs > 0) {
    return `, clamped to ${grantedMs}ms to leave ${reserveMs}ms for this failure and the test's own teardown to run inside the test's timeout`;
  }
  if (budgetMs >= 0) {
    return `, granted no time: only ${budgetMs}ms of the test's own timeout was left, at or below the ${reserveMs}ms reserved for this failure and the test's own teardown`;
  }
  return `, granted no time: the test's own timeout was already overdrawn by ${-budgetMs}ms when this wait began`;
}

function predicateFailure(what: string, thrown: unknown): Error {
  const originalMessage = thrown instanceof Error ? thrown.message : String(thrown);
  const failure = new Error(`while waiting for ${what}: ${originalMessage}`, {
    cause: thrown,
  });
  const originalStack = thrown instanceof Error ? thrown.stack : undefined;
  if (originalStack !== undefined) {
    failure.stack = originalStack.replace(originalMessage, () => failure.message);
  }
  return failure;
}

export async function waitWithinTestBudget(
  what: string,
  predicate: () => boolean | Promise<boolean>,
  options: WaitWithinTestBudgetOptions,
): Promise<void> {
  const { timeoutMs, pollMs = DEFAULT_POLL_MS, reserveMs = DEFAULT_REPORT_RESERVE_MS } = options;
  const startedAt = realNow();
  const budgetMs = remainingTestBudgetMs(startedAt);
  const grantedMs = budgetMs === undefined ? timeoutMs : Math.min(timeoutMs, budgetMs - reserveMs);
  const deadline = startedAt + grantedMs;

  for (;;) {
    let holds: boolean;
    try {
      holds = await predicate();
    } catch (thrown) {
      throw predicateFailure(what, thrown);
    }
    if (holds) return;
    const leftMs = deadline - realNow();
    if (leftMs <= 0) break;
    await new Promise((resolve) => realSetTimeout(resolve, Math.min(pollMs, leftMs)));
  }

  const waitedMs = realNow() - startedAt;
  const note = budgetNote(budgetMs, grantedMs, timeoutMs, reserveMs);
  throw new Error(
    `timed out waiting for ${what} after ${waitedMs}ms (requested ${timeoutMs}ms${note})`,
  );
}
