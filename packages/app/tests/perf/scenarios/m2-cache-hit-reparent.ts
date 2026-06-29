import { markerFor } from '../lib/doc-markers';
import { installLongtaskObserver, readLongtasks } from '../lib/longtask-observer';
import { defineScenario } from '../lib/scenario';

const TARGET_DOC = process.env.OK_PERF_M2_DOC ?? 'PROJECT';
const MARKER_KEY = process.env.OK_PERF_M2_MARKER_KEY ?? TARGET_DOC;
const VIEW_COUNT_HINT = process.env.OK_PERF_M2_VIEW_COUNT ?? '';
const PRIMING_DOC = process.env.OK_PERF_M2_PRIMING ?? 'README';
const EVICT_DOCS_DEFAULT = ['AGENTS', 'CLAUDE', 'STORIES'];
const EVICT_DOCS = (process.env.OK_PERF_M2_EVICT_DOCS ?? EVICT_DOCS_DEFAULT.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const PM_READY_CHARS = 200;
const WAIT_CONTENT_MS = 60_000;
const EVICT_WAIT_MS = 30_000;

async function waitForVisibleProseMirrorByMarker(
  page: import('@playwright/test').Page,
  markerKey: string,
  timeoutMs: number,
): Promise<void> {
  const marker = markerFor(markerKey);
  await page.waitForFunction(
    ({ needle, fallbackChars }: { needle: string | null; fallbackChars: number }) => {
      const nodes = document.querySelectorAll('.ProseMirror');
      for (const n of Array.from(nodes)) {
        const rect = (n as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const txt = n.textContent ?? '';
        if (needle && txt.includes(needle)) return true;
        if (!needle && txt.length >= fallbackChars) return true;
      }
      return false;
    },
    { needle: marker, fallbackChars: PM_READY_CHARS },
    { timeout: timeoutMs },
  );
}

export default defineScenario({
  name: 'm2-cache-hit-reparent',
  description:
    'Cache-hit reparent timing on a doc with known view count; one fixture per invocation.',

  async run(ctx) {
    const { page, opts } = ctx;

    await installLongtaskObserver(page);

    await page.goto(`${opts.target}/#/${encodeURIComponent(PRIMING_DOC)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    try {
      await waitForVisibleProseMirrorByMarker(page, PRIMING_DOC, WAIT_CONTENT_MS);
    } catch {
      ctx.note(`Step 1 failed: could not confirm priming ${PRIMING_DOC}`);
      ctx.recordMetric('reparentMs', -1);
      return;
    }
    ctx.note(`Step 1: primed app + ProviderPool with ${PRIMING_DOC}`);

    await page.goto(`${opts.target}/#/${encodeURIComponent(TARGET_DOC)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    try {
      await waitForVisibleProseMirrorByMarker(page, MARKER_KEY, WAIT_CONTENT_MS);
    } catch {
      ctx.note(`Step 2 failed: could not confirm target ${TARGET_DOC} (marker=${MARKER_KEY})`);
      ctx.recordMetric('reparentMs', -1);
      return;
    }
    ctx.note(`Step 2: cold-loaded ${TARGET_DOC} (cache MISS, populates V2 cache)`);

    const actualViewCount = await page.evaluate(() => {
      const nodes = document.querySelectorAll('.ProseMirror');
      let count = 0;
      for (const root of Array.from(nodes)) {
        const rect = (root as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        count += root.querySelectorAll(
          '[data-mark-type], [data-wiki-link], [data-internal-link]',
        ).length;
        break;
      }
      return count;
    });
    ctx.recordMetric('actualViewCount', actualViewCount);
    ctx.recordMetric('viewCountHint', VIEW_COUNT_HINT || -1);

    for (const doc of EVICT_DOCS) {
      await page.goto(`${opts.target}/#/${encodeURIComponent(doc)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      try {
        await waitForVisibleProseMirrorByMarker(page, doc, EVICT_WAIT_MS);
      } catch {
        ctx.note(`evict-walk soft-failed on ${doc} — Activity demotion proceeds anyway`);
      }
    }
    ctx.note(`Step 3: walked ${EVICT_DOCS.join(',')} to demote ${TARGET_DOC} from Activity`);

    await page.waitForTimeout(500);

    const revisitStartPerf = await page.evaluate(() => performance.now());
    ctx.recordMetric('revisitStartPerf', revisitStartPerf);

    const t0 = Date.now();
    await page.goto(`${opts.target}/#/${encodeURIComponent(TARGET_DOC)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    try {
      await waitForVisibleProseMirrorByMarker(page, MARKER_KEY, WAIT_CONTENT_MS);
    } catch {
      ctx.note(`Step 4 failed: could not confirm ${TARGET_DOC} after revisit`);
      ctx.recordMetric('reparentMs', -1);
      return;
    }
    const coldPoolWarmMs = Date.now() - t0;
    ctx.recordMetric('coldPoolWarmMs', coldPoolWarmMs);

    const reparentMarks = await page.evaluate((boundary: number) => {
      type PmMark = {
        name: string;
        startTime: number;
        duration: number;
        properties?: { kind?: string; viewCount?: number; bytes?: number; docName?: string };
      };
      const ring = (
        globalThis as unknown as {
          __ok_perf?: { marks?: { toArray(): PmMark[] } };
        }
      ).__ok_perf?.marks;
      const buf: PmMark[] = ring ? ring.toArray() : [];
      return buf
        .filter((m) => m.startTime >= boundary)
        .filter((m) => m.name === 'ok/cache/reparent-start' || m.name === 'ok/cache/reparent-end')
        .filter((m) => m.properties?.kind === 'tiptap')
        .map((m) => ({
          name: m.name,
          startTime: m.startTime,
          properties: m.properties ?? {},
        }));
    }, revisitStartPerf);

    const startMarks = reparentMarks
      .filter((m) => m.name === 'ok/cache/reparent-start')
      .sort((a, b) => b.startTime - a.startTime);
    const endMarks = reparentMarks
      .filter((m) => m.name === 'ok/cache/reparent-end')
      .sort((a, b) => b.startTime - a.startTime);

    if (startMarks.length === 0 || endMarks.length === 0) {
      ctx.note(
        `No reparent marks captured in revisit window. Cache-HIT path may not have fired (cache MISS instead?). Marks count: start=${startMarks.length}, end=${endMarks.length}.`,
      );
      ctx.recordMetric('reparentMs', -1);
    } else {
      const start = startMarks[0];
      const end = endMarks[0];
      const reparentMs = end.startTime - start.startTime;
      ctx.recordMetric('reparentMs', Math.round(reparentMs * 100) / 100);
      ctx.recordMetric('revisitMarkStartTime', Math.round(start.startTime * 100) / 100);
      ctx.recordMetric('revisitMarkEndTime', Math.round(end.startTime * 100) / 100);
      ctx.recordMetric('reparentBytes', (start.properties as { bytes?: number }).bytes ?? -1);
      ctx.recordMetric(
        'reparentViewCount',
        (start.properties as { viewCount?: number }).viewCount ?? -1,
      );
      ctx.note(`Step 4: cache-HIT reparentMs=${Math.round(reparentMs)} (wall=${coldPoolWarmMs}ms)`);
    }

    const longTasks = await readLongtasks(page);
    const longestTaskMs = longTasks.reduce((m, t) => Math.max(m, t.duration), 0);
    const tasksInRevisit = longTasks.filter((t) => t.startTime >= revisitStartPerf);
    const longestRevisitTaskMs = tasksInRevisit.reduce((m, t) => Math.max(m, t.duration), 0);
    ctx.recordMetric('observedLongestTaskMs', Math.round(longestTaskMs));
    ctx.recordMetric('revisitLongestTaskMs', Math.round(longestRevisitTaskMs));
    ctx.recordMetric('revisitLongTaskCount', tasksInRevisit.length);

    const pmLenAfterRevisit = await page.evaluate(() => {
      const el = document.querySelector('.ProseMirror');
      return el ? (el.textContent ?? '').length : 0;
    });
    ctx.recordMetric('pmLenAfterRevisit', pmLenAfterRevisit);

    ctx.recordMetric('docName', TARGET_DOC);
    ctx.recordMetric('markerKey', MARKER_KEY);
  },
});
