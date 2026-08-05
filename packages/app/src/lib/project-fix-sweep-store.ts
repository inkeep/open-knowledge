/**
 * project-fix-sweep-store — session-wide owner of the project-scope "Fix all"
 * sweep.
 *
 * The sweep is a module store, not panel state, so its lifetime is the
 * operation's rather than any one panel's mount. That matters because the
 * Problems tab is rendered conditionally: were the run owned by the panel,
 * switching to Timeline would unmount it and end the run mid-project —
 * silently, because a correct teardown declines to toast into a tree nobody is
 * watching. As a store the run belongs to the operation and the panel is only a
 * subscriber, so every unmount path is covered.
 *
 * Toasts are raised from here rather than the panel for the same reason — the
 * app-root `<Toaster>` outlives every panel, so the user is told how a sweep
 * ended whatever they are looking at.
 *
 * A running sweep is still client-side, so a page reload ends it. Surviving
 * that would mean moving the loop server-side.
 */
import { plural, t } from '@lingui/core/macro';
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { runProjectFixSweep, type SweepFixOutcome, sweepSleep } from '@/components/problems-sweep';

/** Files swept so far out of the total, published in chunks by the driver. */
export interface ProjectFixSweepProgress {
  readonly done: number;
  readonly total: number;
}

/**
 * A file the sweep fixes. Only the path is needed — to address the fix and to
 * name the first casualty in a failure toast — so the store stays indifferent
 * to the shape of the audit row the caller pulled it from.
 */
export interface ProjectFixSweepItem {
  readonly file: string;
}

/**
 * Both `items` and `fixItem` are captured at call time, not re-read as the
 * sweep runs: a caller whose audit moves underneath it keeps sweeping the list
 * it started with. A second call while one is running is declined outright, not
 * queued — so a panel that re-renders (or a second panel that mounts) mid-sweep
 * cannot swap the list out from under the run.
 */
export interface StartProjectFixSweepOptions {
  readonly items: readonly ProjectFixSweepItem[];
  /**
   * Runs one file's fix. Must resolve rather than reject, per
   * {@link runProjectFixSweep}'s contract.
   */
  readonly fixItem: (item: ProjectFixSweepItem) => Promise<SweepFixOutcome>;
  /** Awaitable delay; injected so tests drive pacing and backoff without a clock. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Non-null exactly while a sweep is running; doubles as the re-entry guard. */
let progress: ProjectFixSweepProgress | null = null;
let cancelRequested = false;
const listeners = new Set<() => void>();
const settledListeners = new Set<() => void>();

function setProgress(next: ProjectFixSweepProgress | null): void {
  progress = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Progress of the running sweep, or null when none is running. */
export function getProjectFixSweepProgress(): ProjectFixSweepProgress | null {
  return progress;
}

/**
 * Subscribe to the running sweep's progress. Every mounted panel sees the same
 * run, so a panel that mounts mid-sweep picks it up rather than showing an idle
 * Fix-all button for a project that is actively being rewritten.
 */
export function useProjectFixSweep(): ProjectFixSweepProgress | null {
  return useSyncExternalStore(subscribe, getProjectFixSweepProgress, getProjectFixSweepProgress);
}

/**
 * Fires once each time a sweep ends, however it ended. The panel re-audits on
 * this; a panel that was unmounted at the time simply never hears it, and its
 * remount reloads the plane anyway.
 */
export function subscribeToProjectFixSweepSettled(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => {
    settledListeners.delete(listener);
  };
}

/** End the running sweep at the next file boundary. Files already fixed stay fixed. */
export function cancelProjectFixSweep(): void {
  cancelRequested = true;
}

/**
 * Report how a sweep ended. Terminal failures are logged in full — a bulk
 * failure (one root cause across many files, or a mid-sweep server restart)
 * otherwise leaves a trail for only the file the toast names.
 */
function reportSweepOutcome(
  failures: readonly { item: ProjectFixSweepItem; detail: string | null }[],
  cancelled: boolean,
  total: number,
): void {
  if (failures.length > 0) {
    console.warn(
      `[lint] fix-all: ${failures.length} of ${total} files failed`,
      failures.map((failure) => ({ file: failure.item.file, detail: failure.detail })),
    );
    // Suppressed on a user stop: they know why it ended, and a failure toast
    // there reads as "your stop broke something".
    if (!cancelled) {
      // Name the first casualty so the toast is actionable — "1 of 10 failed"
      // alone gives the user nothing to act on. The detail is the server's
      // problem+json title (untranslated, like the rule-write error toasts).
      const first = failures[0];
      toast.error(t`Could not fix ${failures.length} of ${total} files.`, {
        description:
          first === undefined
            ? undefined
            : `${first.item.file}${first.detail === null ? '' : ` — ${first.detail}`}`,
      });
    }
  }
  if (cancelled) {
    // A stop leaves the project genuinely half-fixed, which is fine — every
    // file already swept stays fixed. Say so; the settled listener in any
    // mounted panel then re-audits, replacing the count with what actually
    // remains.
    toast.info(t`Stopped fixing. Files already fixed stay fixed.`);
    return;
  }
  // A sweep can now finish with nobody watching the progress counter, so
  // completion needs a signal of its own rather than relying on the count
  // landing on N/N in a panel that may not be mounted.
  //
  // The count is files ATTEMPTED, not files whose content actually changed: the
  // driver reports only failures, and `fixLintDoc`'s per-file `fixedCount` is
  // dropped by `SweepFixOutcome`'s success arm. A file the audit called fixable
  // that something else cleaned up before its turn still counts here. Deliberate
  // — it matches the number the user clicked ("Fix all (N)"), and narrowing it
  // would mean reopening the driver's result contract to thread `fixedCount`
  // back out.
  if (failures.length === 0) {
    toast.success(t`Fixed ${plural(total, { one: '# file', other: '# files' })}.`);
  }
}

/**
 * Start the project-scope sweep: fix each file in series, publishing chunked
 * progress, and report how it ended. Declines while a sweep is already running
 * — one project-wide rewrite at a time, however many panels are mounted.
 *
 * Resolves when the sweep settles. Callers fire-and-forget; the outcome reaches
 * the user through toasts and subscribers, not the returned promise.
 */
export async function startProjectFixSweep({
  items,
  fixItem,
  sleep = sweepSleep,
}: StartProjectFixSweepOptions): Promise<void> {
  if (progress !== null || items.length === 0) return;
  const total = items.length;
  // Clear any stop left over from a previous sweep, or this one ends instantly.
  cancelRequested = false;
  setProgress({ done: 0, total });
  let failures: { item: ProjectFixSweepItem; detail: string | null }[] = [];
  let cancelled = false;
  let threw = false;
  try {
    const result = await runProjectFixSweep<ProjectFixSweepItem>({
      items,
      fixItem,
      sleep,
      onProgress: (done) => setProgress({ done, total }),
      shouldContinue: () => !cancelRequested,
    });
    failures = result.failures;
    cancelled = result.cancelled;
  } catch (err) {
    // `fixItem` is contracted to resolve rather than reject, so this is a
    // caller bug — but the progress counter is module state with no unmount to
    // clear it, and a wedged "Fixing 3/10" would leave the button disabled
    // with a page reload as the only way out. Clear it and say so instead.
    console.warn('[lint] fix-all: sweep threw', err);
    threw = true;
  } finally {
    setProgress(null);
  }
  // `finally`, not `catch`: reporting the outcome runs third-party toast calls
  // and locale lookups, and if any of them throws, the settled listeners must
  // still fire — a panel that never hears the sweep ended shows a stale plane
  // for the rest of the session. Nothing is swallowed; the throw still
  // propagates once the listeners have run.
  try {
    if (threw) toast.error(t`Fixing files stopped unexpectedly.`);
    else reportSweepOutcome(failures, cancelled, total);
  } finally {
    for (const listener of settledListeners) listener();
  }
}

/** Test-only: drop the in-flight sweep state and every subscriber. Production
 *  never calls this — the store is a session singleton. */
export function __resetProjectFixSweepForTests(): void {
  progress = null;
  // True, not false: a sweep a previous test left running only stops when it
  // sees a cancel, and until then it writes into the store this just reset.
  // Safe because every start clears the flag before its first file.
  cancelRequested = true;
  listeners.clear();
  settledListeners.clear();
}
