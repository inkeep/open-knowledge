import type { ProblemType } from '@inkeep/open-knowledge-core';

/**
 * The project-scope "Fix all" sweep fixes one file per iteration. Committing the
 * progress counter to React state on every file makes a large sweep (thousands
 * of files) re-render the panel — and re-announce to a screen reader — once per
 * file. That per-file churn, not the network, is what makes the sweep feel like
 * it locks the app up. Progress is instead published in chunks of this size, so
 * a ~2,000-file sweep produces tens of updates rather than thousands.
 */
export const SWEEP_PROGRESS_CHUNK = 50;

/**
 * How many progress publishes a sweep aims for when its file count is too small
 * to reach {@link SWEEP_PROGRESS_CHUNK} boundaries. A fixed chunk alone gives a
 * sweep under one chunk exactly one publish — on its last file, which the
 * teardown that clears the counter immediately supersedes — so the counter sits
 * at its starting value for the whole run. On a slow server that reads as a hung
 * app, which is the failure chunking exists to avoid, not to cause. For any
 * sweep below {@link SWEEP_PROGRESS_CHUNK} × this floor (500 files) the floor
 * deliberately publishes MORE often than the chunk would, so the counter still
 * advances; ten keeps those extra publishes few enough not to pressure
 * re-renders while still moving the counter about every tenth of the sweep.
 */
export const SWEEP_PROGRESS_MIN_UPDATES = 10;

/**
 * Files between progress publishes for a sweep of `total` files: one chunk at
 * full size, shrinking on small sweeps so the counter still visibly advances.
 * Capped at {@link SWEEP_PROGRESS_CHUNK}, so every sweep of {@link
 * SWEEP_PROGRESS_CHUNK} × {@link SWEEP_PROGRESS_MIN_UPDATES} files or more keeps
 * exactly the publish cadence it had before the floor existed.
 */
export function sweepProgressInterval(total: number): number {
  return Math.min(SWEEP_PROGRESS_CHUNK, Math.max(1, Math.ceil(total / SWEEP_PROGRESS_MIN_UPDATES)));
}

/**
 * Whether the sweep should publish its progress counter after finishing the
 * `done`-th of `total` files. True at each interval boundary and unconditionally
 * on the last file, so the reported count lands exactly on `total` even when
 * `total` is not a multiple of the interval — the counter never stalls one
 * interval short of the end.
 *
 * `done` is the 1-based count of files finished so far; the sweep loop calls
 * this starting at 1 (the first completion), never 0.
 */
export function shouldFlushSweepProgress(done: number, total: number): boolean {
  return done === total || done % sweepProgressInterval(total) === 0;
}

/**
 * The problem-type URN the server sends with a 503 when the shared agent-session
 * pool is saturated. Stable wire contract; the sweep matches it literally to
 * tell a retryable capacity refusal from a terminal failure. `satisfies
 * ProblemType` binds it to core's canonical URN union, so a server-side rename
 * fails this file's typecheck rather than silently reclassifying every capacity
 * refusal as a terminal failure — the exact bug the retry path exists to avoid.
 */
export const CAPACITY_PROBLEM_TYPE = 'urn:ok:error:too-many-agent-sessions' satisfies ProblemType;

/**
 * Backoff before each successive capacity retry, in milliseconds — one entry per
 * retry, so the array length is the retry budget. Short and exponential: the
 * pool frees space as soon as an in-flight session crosses the server's idle
 * eviction floor, so the sweep pauses briefly and climbs only if refusals
 * persist. The cumulative wait (7.75s) spans that 5s floor with margin, so a
 * file that keeps hitting capacity still resolves rather than being dropped.
 * Deliberately far shorter per step than the server's Retry-After hint, which is
 * sized for a lone client, not a self-paced sweep that already leaves headroom.
 */
export const CAPACITY_RETRY_BACKOFF_MS: readonly number[] = [250, 500, 1000, 2000, 4000];

/**
 * Delay between successive files, in milliseconds. Collapsing the plane lets the
 * sweep run fast enough to saturate the shared session pool; this pulls the
 * sustained rate back below that ceiling so concurrent agent writes keep their
 * share of the budget. Small on purpose — the per-file round trip already paces
 * most of the interval — and a tuning knob, not a measured constant.
 */
export const SWEEP_PACE_DELAY_MS = 15;

/**
 * A file's fix outcome as the sweep consumes it: success, or a failure carrying
 * the human detail plus the HTTP status and problem-type URN the retry decision
 * reads. Structurally a widening of `fixLintDoc`'s return — its `{ ok: true }`
 * success arm carries a `result` the sweep ignores.
 */
export type SweepFixOutcome =
  | { ok: true }
  | { ok: false; errorDetail: string | null; status: number | null; problemType: string | null };

/**
 * Whether a fix failure is a retryable capacity refusal — the server declining
 * for agent-session capacity (503 + the capacity URN), which clears on its own
 * once in-flight sessions idle out — rather than a terminal failure to report.
 */
export function isCapacityRefusal(outcome: {
  status: number | null;
  problemType: string | null;
}): boolean {
  return outcome.status === 503 && outcome.problemType === CAPACITY_PROBLEM_TYPE;
}

export interface ProjectFixSweepDeps<T> {
  readonly items: readonly T[];
  /**
   * Runs one file's fix (a POST round trip) and resolves to its outcome. Must
   * resolve, never reject: the sweep does not wrap this call, so a rejection
   * propagates out uncaught and aborts the run mid-sweep. Surface every failure
   * as a `{ ok: false }` outcome rather than throwing.
   */
  readonly fixItem: (item: T) => Promise<SweepFixOutcome>;
  /** Awaitable delay; injected so tests drive pacing and backoff without a clock. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Publishes chunked progress; called at chunk boundaries and on the last file. */
  readonly onProgress: (done: number, total: number) => void;
  /** False once the caller wants the sweep to stop; ends it at a file boundary. */
  readonly shouldContinue: () => boolean;
}

export interface ProjectFixSweepResult<T> {
  readonly failures: { item: T; detail: string | null }[];
  /** True when shouldContinue() ended the sweep before the last file. */
  readonly cancelled: boolean;
}

/**
 * One file's fix, retried on capacity refusal with the bounded backoff schedule.
 * A non-capacity failure returns on the first attempt (no retry); success short-
 * circuits. Re-checks liveness around each backoff so a stop landing mid-wait
 * ends the retries.
 */
async function fixItemWithCapacityRetry<T>(
  item: T,
  deps: Pick<ProjectFixSweepDeps<T>, 'fixItem' | 'sleep' | 'shouldContinue'>,
): Promise<SweepFixOutcome> {
  let outcome = await deps.fixItem(item);
  for (const backoffMs of CAPACITY_RETRY_BACKOFF_MS) {
    if (outcome.ok || !isCapacityRefusal(outcome) || !deps.shouldContinue()) break;
    // A retry that succeeds is otherwise invisible: the sweep absorbs the 503
    // by design, so sustained pool pressure would show up only as a slower
    // wall clock, with nothing to tell an operator whether to tune the session
    // cap or the pace. Costs nothing on the common zero-retry path.
    console.debug('[sweep] capacity refusal, backing off %dms', backoffMs);
    await deps.sleep(backoffMs);
    if (!deps.shouldContinue()) break;
    outcome = await deps.fixItem(item);
  }
  return outcome;
}

/**
 * Drive the project-scope "Fix all" sweep: fix each file in series, pacing
 * between files and retrying capacity refusals so the sweep neither saturates
 * the shared session pool nor drops files the server merely deferred. Progress
 * is published in chunks; a caller that withdraws consent ends the sweep early.
 * Terminal (non-capacity) failures don't stop the sweep — they're collected and
 * returned for the caller to surface. Pure over its injected effects, so pacing,
 * retry, and cancellation are testable without a real clock.
 */
export async function runProjectFixSweep<T>(
  deps: ProjectFixSweepDeps<T>,
): Promise<ProjectFixSweepResult<T>> {
  const total = deps.items.length;
  const failures: { item: T; detail: string | null }[] = [];
  for (const [index, item] of deps.items.entries()) {
    // Pace between files, never before the first, so the sustained rate sits
    // below the session ceiling without adding a needless leading delay.
    if (index > 0) {
      await deps.sleep(SWEEP_PACE_DELAY_MS);
      if (!deps.shouldContinue()) return { failures, cancelled: true };
    }
    const outcome = await fixItemWithCapacityRetry(item, deps);
    // Record before the cancellation bail, not after: this file's fix already
    // ran to a verdict, so bailing first would drop a real failure from the
    // caller's diagnostic log purely because the user stopped the sweep in that
    // window. Recording first costs nothing — the bail below still returns
    // without starting another file.
    if (!outcome.ok) failures.push({ item, detail: outcome.errorDetail });
    if (!deps.shouldContinue()) return { failures, cancelled: true };
    const done = index + 1;
    if (shouldFlushSweepProgress(done, total)) deps.onProgress(done, total);
  }
  return { failures, cancelled: false };
}

/** Real awaitable delay for production pacing/backoff; tests inject their own. */
export function sweepSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
