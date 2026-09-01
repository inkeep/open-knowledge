import type { Page } from '@playwright/test';

export interface LongTaskRecord {
  startTime: number;
  duration: number;
  name: string;
}

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
    } catch {}
  });
}

export async function readLongtasks(page: Page): Promise<LongTaskRecord[]> {
  return await page.evaluate(() => {
    const store = (globalThis as unknown as { __okScenLongTasks?: LongTaskRecord[] })
      .__okScenLongTasks;
    return store ?? [];
  });
}
