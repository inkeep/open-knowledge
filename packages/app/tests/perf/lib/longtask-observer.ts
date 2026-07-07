/**
 * Long-task observer helper for perf scenarios.
 *
 * Replaces three inline duplicates (cold-load-big-doc.ts, cold-pool-warm.ts,
 * m2-cache-hit-reparent.ts) and unblocks the seven scenarios that were missing
 * scenario-side long-task accounting (activity-mount-sweep, m3-defer-mount-sweep,
 * memory-per-editor, mode-toggle, outline-polling, warm-switch, warm-switch-cached).
 *
 * The observer must be installed BEFORE the first `page.goto(...)` so that
 * `buffered: true` back-fills any long tasks that landed before the script
 * ran. Reading is via `readLongtasks(page)`, which drains the in-page array
 * and returns it on the Node side for filtering / aggregation.
 *
 * The CDP tracer also captures long tasks (via Tracing.dataCollected), but
 * the in-page PerformanceObserver is independent and lets scenarios filter
 * by `startTime >= revisitStartPerf` for cold-pool-warm-style measurements
 * where only the post-revisit window matters.
 */

import type { Page } from '@playwright/test';

export interface LongTaskRecord {
  startTime: number;
  duration: number;
  name: string;
}

/**
 * Install a `PerformanceObserver({type:'longtask', buffered:true})` in the
 * page's init script so `globalThis.__okScenLongTasks` collects every long
 * task from page load onward. Idempotent — calling twice during one scenario
 * is harmless (the second observer just stacks; same store).
 *
 * Must be called before `page.goto(...)` for `buffered: true` to back-fill.
 */
export async function installLongtaskObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store: { startTime: number; duration: number; name: string }[] = [];
    (globalThis as unknown as { __okScenLongTasks: typeof store }).__okScenLongTasks = store;
    try {
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          store.push({ startTime: e.startTime, duration: e.duration, name: e.name });
        }
      });
      obs.observe({ type: 'longtask', buffered: true });
    } catch {
      // longtask API unsupported in this browser — non-fatal.
    }
  });
}

/**
 * Drain the in-page long-task store on the Node side. Returns an empty array
 * when the observer was never installed or the API is unsupported.
 */
export async function readLongtasks(page: Page): Promise<LongTaskRecord[]> {
  return await page.evaluate(() => {
    const store = (globalThis as unknown as { __okScenLongTasks?: LongTaskRecord[] })
      .__okScenLongTasks;
    return store ?? [];
  });
}
