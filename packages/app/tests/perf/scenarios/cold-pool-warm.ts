import { markerFor } from '../lib/doc-markers';
import { installLongtaskObserver, readLongtasks } from '../lib/longtask-observer';
import { defineScenario } from '../lib/scenario';

const BIG_DOC = process.env.OK_PERF_BIG_DOC ?? 'PROJECT';
const WARM_DOC = process.env.OK_PERF_SMALL_DOC ?? 'README';

const EVICT_DOCS_DEFAULT = ['AGENTS', 'CLAUDE', 'README'];
const EVICT_DOCS = (process.env.OK_PERF_EVICT_DOCS ?? EVICT_DOCS_DEFAULT.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const PM_READY_CHARS = 500;
const WAIT_CONTENT_MS = 90_000;

async function waitForVisibleProseMirrorForDoc(
  page: import('@playwright/test').Page,
  docName: string,
  timeoutMs: number,
): Promise<void> {
  const marker = markerFor(docName);
  if (marker) {
    await page.waitForFunction(
      (needle: string) => {
        const nodes = document.querySelectorAll('.ProseMirror');
        for (const n of Array.from(nodes)) {
          const rect = (n as HTMLElement).getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0;
          if (visible && (n.textContent ?? '').includes(needle)) return true;
        }
        return false;
      },
      marker,
      { timeout: timeoutMs },
    );
    return;
  }
  await page.waitForFunction(
    (chars: number) => {
      const nodes = document.querySelectorAll('.ProseMirror');
      for (const n of Array.from(nodes)) {
        const rect = (n as HTMLElement).getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        if (visible && (n.textContent ?? '').length >= chars) return true;
      }
      return false;
    },
    PM_READY_CHARS,
    { timeout: timeoutMs },
  );
}

export default defineScenario({
  name: 'cold-pool-warm',
  description:
    'Pool-resident, Activity-evicted cold remount: isolates TipTap+PM+React cost from Y.Doc sync.',

  async run(ctx) {
    const { page, opts } = ctx;

    await installLongtaskObserver(page);

    await page.goto(`${opts.target}/#/${encodeURIComponent(WARM_DOC)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    try {
      await waitForVisibleProseMirrorForDoc(page, WARM_DOC, WAIT_CONTENT_MS);
    } catch {
      ctx.note(`Step 1 failed: could not confirm ${WARM_DOC} content`);
      ctx.recordMetric('coldPoolWarmMs', -1);
      return;
    }
    ctx.note(`Step 1: loaded ${WARM_DOC}`);

    await page.goto(`${opts.target}/#/${encodeURIComponent(BIG_DOC)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    try {
      await waitForVisibleProseMirrorForDoc(page, BIG_DOC, WAIT_CONTENT_MS);
    } catch {
      ctx.note(`Step 2 failed: could not confirm ${BIG_DOC} content`);
      ctx.recordMetric('coldPoolWarmMs', -1);
      return;
    }
    ctx.note(`Step 2: loaded ${BIG_DOC} (cold + Y.Doc sync)`);

    const pmLenAfterCold = await page.evaluate(() => {
      const el = document.querySelector('.ProseMirror');
      return el ? (el.textContent ?? '').length : 0;
    });
    ctx.recordMetric('pmLenAfterCold', pmLenAfterCold);

    const ytextLenAfterCold = await page.evaluate((docName: string) => {
      const pool = (
        globalThis as unknown as {
          __docPool?: { entries: () => Iterable<[string, { provider: { document: unknown } }]> };
        }
      ).__docPool;
      if (!pool?.entries) return null;
      for (const [name, e] of pool.entries()) {
        if (name === docName) {
          const doc = e.provider.document as {
            getText: (k: string) => { length: number };
          };
          return doc.getText('source').length;
        }
      }
      return null;
    }, BIG_DOC);
    ctx.recordMetric('ytextLenAfterCold', ytextLenAfterCold ?? -1);

    for (const doc of EVICT_DOCS) {
      await page.goto(`${opts.target}/#/${encodeURIComponent(doc)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      try {
        await waitForVisibleProseMirrorForDoc(page, doc, 30_000);
      } catch {
        ctx.note(`Step 3 warning: ${doc} did not render within 30s`);
      }
    }
    ctx.note(`Step 3: evicted ${BIG_DOC} via navigation through ${EVICT_DOCS.join(',')}`);

    await page.waitForTimeout(500);

    const revisitStartPerf = await page.evaluate(() => performance.now());
    ctx.recordMetric('revisitStartPerf', revisitStartPerf);

    const clickAt = Date.now();
    await page.goto(`${opts.target}/#/${encodeURIComponent(BIG_DOC)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    try {
      await waitForVisibleProseMirrorForDoc(page, BIG_DOC, WAIT_CONTENT_MS);
    } catch {
      ctx.note(`Step 4 failed: could not confirm ${BIG_DOC} content after revisit`);
      ctx.recordMetric('coldPoolWarmMs', -1);
      return;
    }
    const coldPoolWarmMs = Date.now() - clickAt;
    ctx.recordMetric('coldPoolWarmMs', coldPoolWarmMs);
    ctx.note(`Step 4: revisited ${BIG_DOC} in ${coldPoolWarmMs}ms`);

    const longTasks = await readLongtasks(page);
    const longestTaskMs = longTasks.reduce((m, t) => Math.max(m, t.duration), 0);
    const tasksInRevisit = longTasks.filter((t) => t.startTime >= revisitStartPerf);
    const longestRevisitTaskMs = tasksInRevisit.reduce((m, t) => Math.max(m, t.duration), 0);

    ctx.recordMetric('observedLongTaskCount', longTasks.length);
    ctx.recordMetric('observedLongestTaskMs', Math.round(longestTaskMs));
    ctx.recordMetric('revisitLongTaskCount', tasksInRevisit.length);
    ctx.recordMetric('revisitLongestTaskMs', Math.round(longestRevisitTaskMs));
    ctx.recordMetric(
      'revisitLongTaskSumMs',
      Math.round(tasksInRevisit.reduce((s, t) => s + t.duration, 0)),
    );

    const pmLenAfterRevisit = await page.evaluate(() => {
      const el = document.querySelector('.ProseMirror');
      return el ? (el.textContent ?? '').length : 0;
    });
    ctx.recordMetric('pmLenAfterRevisit', pmLenAfterRevisit);

    const instrumented = await page.evaluate(
      () =>
        (globalThis as unknown as { __okColdMountInstrumented?: boolean })
          .__okColdMountInstrumented ?? false,
    );
    ctx.recordMetric('coldMountInstrumented', instrumented);
  },
});
