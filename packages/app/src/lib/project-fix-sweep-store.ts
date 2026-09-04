import { plural, t } from '@lingui/core/macro';
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { runProjectFixSweep, type SweepFixOutcome, sweepSleep } from '@/components/problems-sweep';

export interface ProjectFixSweepProgress {
  readonly done: number;
  readonly total: number;
}

export interface ProjectFixSweepItem {
  readonly file: string;
}

export interface StartProjectFixSweepOptions {
  readonly items: readonly ProjectFixSweepItem[];
  readonly fixItem: (item: ProjectFixSweepItem) => Promise<SweepFixOutcome>;
  readonly sleep?: (ms: number) => Promise<void>;
}

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

export function getProjectFixSweepProgress(): ProjectFixSweepProgress | null {
  return progress;
}

export function useProjectFixSweep(): ProjectFixSweepProgress | null {
  return useSyncExternalStore(subscribe, getProjectFixSweepProgress, getProjectFixSweepProgress);
}

export function subscribeToProjectFixSweepSettled(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => {
    settledListeners.delete(listener);
  };
}

export function cancelProjectFixSweep(): void {
  cancelRequested = true;
}

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
    if (!cancelled) {
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
    toast.info(t`Stopped fixing. Files already fixed stay fixed.`);
    return;
  }
  if (failures.length === 0) {
    toast.success(t`Fixed ${plural(total, { one: '# file', other: '# files' })}.`);
  }
}

export async function startProjectFixSweep({
  items,
  fixItem,
  sleep = sweepSleep,
}: StartProjectFixSweepOptions): Promise<void> {
  if (progress !== null || items.length === 0) return;
  const total = items.length;
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
    console.warn('[lint] fix-all: sweep threw', err);
    threw = true;
  } finally {
    setProgress(null);
  }
  try {
    if (threw) toast.error(t`Fixing files stopped unexpectedly.`);
    else reportSweepOutcome(failures, cancelled, total);
  } finally {
    for (const listener of settledListeners) listener();
  }
}

export function __resetProjectFixSweepForTests(): void {
  progress = null;
  cancelRequested = true;
  listeners.clear();
  settledListeners.clear();
}
