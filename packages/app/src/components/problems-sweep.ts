import type { ProblemType } from '@inkeep/open-knowledge-core';

export const SWEEP_PROGRESS_CHUNK = 50;

export const SWEEP_PROGRESS_MIN_UPDATES = 10;

export function sweepProgressInterval(total: number): number {
  return Math.min(SWEEP_PROGRESS_CHUNK, Math.max(1, Math.ceil(total / SWEEP_PROGRESS_MIN_UPDATES)));
}

export function shouldFlushSweepProgress(done: number, total: number): boolean {
  return done === total || done % sweepProgressInterval(total) === 0;
}

export const CAPACITY_PROBLEM_TYPE = 'urn:ok:error:too-many-agent-sessions' satisfies ProblemType;

export const CAPACITY_RETRY_BACKOFF_MS: readonly number[] = [250, 500, 1000, 2000, 4000];

export const SWEEP_PACE_DELAY_MS = 15;

export type SweepFixOutcome =
  | { ok: true }
  | { ok: false; errorDetail: string | null; status: number | null; problemType: string | null };

export function isCapacityRefusal(outcome: {
  status: number | null;
  problemType: string | null;
}): boolean {
  return outcome.status === 503 && outcome.problemType === CAPACITY_PROBLEM_TYPE;
}

export interface ProjectFixSweepDeps<T> {
  readonly items: readonly T[];
  readonly fixItem: (item: T) => Promise<SweepFixOutcome>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onProgress: (done: number, total: number) => void;
  readonly shouldContinue: () => boolean;
}

export interface ProjectFixSweepResult<T> {
  readonly failures: { item: T; detail: string | null }[];
  readonly cancelled: boolean;
}

async function fixItemWithCapacityRetry<T>(
  item: T,
  deps: Pick<ProjectFixSweepDeps<T>, 'fixItem' | 'sleep' | 'shouldContinue'>,
): Promise<SweepFixOutcome> {
  let outcome = await deps.fixItem(item);
  for (const backoffMs of CAPACITY_RETRY_BACKOFF_MS) {
    if (outcome.ok || !isCapacityRefusal(outcome) || !deps.shouldContinue()) break;
    console.debug('[sweep] capacity refusal, backing off %dms', backoffMs);
    await deps.sleep(backoffMs);
    if (!deps.shouldContinue()) break;
    outcome = await deps.fixItem(item);
  }
  return outcome;
}

export async function runProjectFixSweep<T>(
  deps: ProjectFixSweepDeps<T>,
): Promise<ProjectFixSweepResult<T>> {
  const total = deps.items.length;
  const failures: { item: T; detail: string | null }[] = [];
  for (const [index, item] of deps.items.entries()) {
    if (index > 0) {
      await deps.sleep(SWEEP_PACE_DELAY_MS);
      if (!deps.shouldContinue()) return { failures, cancelled: true };
    }
    const outcome = await fixItemWithCapacityRetry(item, deps);
    if (!outcome.ok) failures.push({ item, detail: outcome.errorDetail });
    if (!deps.shouldContinue()) return { failures, cancelled: true };
    const done = index + 1;
    if (shouldFlushSweepProgress(done, total)) deps.onProgress(done, total);
  }
  return { failures, cancelled: false };
}

export function sweepSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
