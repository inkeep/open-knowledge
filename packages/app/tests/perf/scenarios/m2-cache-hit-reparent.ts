/**
 * Cache-hit reparent view-count curve scenario.
 *
 * Targets the cache-HIT path of the V2 editor cache on a doc with N views
 * so we can read the `ok/cache/reparent-{start,end}` span marks emitted by
 * `mountTiptapEditor` and characterize how `reparentMs` scales with view
 * count.
 *
 * Single-shot per fixture: one scenario invocation produces one row of curve
 * data. The N-point sweep is built by an outer driver that loops fixtures +
 * restarts the dev server (since `OK_TEST_CONTENT_DIR` is read by
 * `hocuspocus-plugin.ts` at server boot). Aggregation happens at evidence
 * synthesis time. Rationale: baseline JSON shape is single-doc-set per
 * file; in-scenario sweeps risk memory saturation across many cells;
 * `perf-compare.sh` understands `scenarios.<name>.docs.<doc>.<metric>` shape.
 *
 * Flow:
 *   1. Cold-load PRIMING_DOC (small) — bootstraps ProviderPool and app shell.
 *   2. Cold-load TARGET_DOC — populates V2 cache for it (cache MISS).
 *   3. Navigate through ≥3 EVICT_DOCS to demote TARGET_DOC from the Activity
 *      mount list (`ACTIVITY_MOUNT_LIMIT=3`). V2 cache still holds it.
 *   4. Navigate BACK to TARGET_DOC. The cache-HIT path runs and
 *      `ok/cache/reparent-{start,end}` marks fire in `editor-cache.ts`.
 *   5. Drain marks; pair the most recent revisit-window {start, end} for
 *      kind=tiptap; record `reparentMs`.
 *
 * Inputs (env vars, mirroring `OK_PERF_BIG_DOC` precedent):
 *   - `OK_PERF_M2_DOC` — required. URL doc identifier (e.g., `FIXTURE` for
 *     fixture mode; `ARCHITECTURE` or `PROJECT` for natural anchors).
 *   - `OK_PERF_M2_MARKER_KEY` — optional override for the doc-markers lookup;
 *     defaults to `OK_PERF_M2_DOC`. For fixture mode no override is needed —
 *     `markerFor('FIXTURE')` resolves to null and the wait falls back to the
 *     PM_READY_CHARS=200 content-length heuristic (every fixture body clears it).
 *   - `OK_PERF_M2_VIEW_COUNT` — informational; written to JSON output.
 *   - `OK_PERF_M2_EVICT_DOCS` — comma-separated list. Defaults to
 *     `AGENTS,CLAUDE,README` (works for repo-root mode). For fixture mode,
 *     pass non-existent doc names like `DECOY1,DECOY2,DECOY3` — eviction is
 *     by Activity mount-list demotion, not by content load success.
 *
 * Output JSON `metrics`:
 *   {
 *     docName, viewCount, actualViewCount,
 *     reparentMs,                   // primary signal
 *     coldPoolWarmMs,               // wall-clock revisit
 *     observedLongestTaskMs,
 *     revisitLongestTaskMs,
 *     revisitMarkStartTime, revisitMarkEndTime,  // raw mark startTimes
 *     revisitStartPerf,             // filter boundary for marks
 *     pmLenAfterRevisit,
 *     reparentBytes, reparentViewCount  // properties from the mark itself
 *   }
 *
 * Span-mark sites: TipTap reparent emission lives in `editor-cache.ts`'s
 * `mountTiptapEditor` cache-hit path (mark name `ok/cache/reparent-start`
 * + `ok/cache/reparent-end`). CM6 emits the symmetric pair from
 * `mountCmEditor` (not used in this scenario). Closest scenario sibling:
 * `cold-pool-warm.ts` for cache-resident revisits, `warm-switch-cached.ts`
 * for cache-HIT revisit timing. Synthetic view-count fixtures live under
 * `tests/perf/fixtures/views-{25,50,100,200,400}/FIXTURE.md`.
 */

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

    // ─── Step 1: cold-load PRIMING_DOC. ─────────────────────────────────────
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

    // ─── Step 2: cold-load TARGET_DOC — populates V2 cache (MISS path). ─────
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

    // Capture actual view count from the live editor for cross-check vs hint.
    const actualViewCount = await page.evaluate(() => {
      const nodes = document.querySelectorAll('.ProseMirror');
      let count = 0;
      for (const root of Array.from(nodes)) {
        const rect = (root as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // Internal-link + wiki-link chips render as data-mark-type elements
        // per editor-cache view-count contract (post-V2). Best-effort selector:
        // count contenteditable mark wrappers.
        count += root.querySelectorAll(
          '[data-mark-type], [data-wiki-link], [data-internal-link]',
        ).length;
        break;
      }
      return count;
    });
    ctx.recordMetric('actualViewCount', actualViewCount);
    ctx.recordMetric('viewCountHint', VIEW_COUNT_HINT || -1);

    // ─── Step 3: navigate to EVICT_DOCS to demote TARGET_DOC from Activity. ─
    for (const doc of EVICT_DOCS) {
      await page.goto(`${opts.target}/#/${encodeURIComponent(doc)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      try {
        await waitForVisibleProseMirrorByMarker(page, doc, EVICT_WAIT_MS);
      } catch {
        // Fail-soft: in fixture mode the evict docs don't exist, but the
        // Activity mount list still demotes TARGET via mount-order rotation.
        ctx.note(`evict-walk soft-failed on ${doc} — Activity demotion proceeds anyway`);
      }
    }
    ctx.note(`Step 3: walked ${EVICT_DOCS.join(',')} to demote ${TARGET_DOC} from Activity`);

    // Settle before the cache-HIT measurement. Same as cold-pool-warm.ts.
    await page.waitForTimeout(500);

    // Boundary for filtering marks emitted in step 4.
    const revisitStartPerf = await page.evaluate(() => performance.now());
    ctx.recordMetric('revisitStartPerf', revisitStartPerf);

    // ─── Step 4: navigate back to TARGET — cache HIT, reparent fires. ───────
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

    // ─── Drain reparent marks emitted during the revisit window. ────────────
    // Marks are buffered on `globalThis.__ok_perf.marks` per the perf
    // instrumentation contract; the driver also drains them into the result,
    // but we read inline so we can pair start/end and record reparentMs as
    // the primary metric.
    const reparentMarks = await page.evaluate((boundary: number) => {
      type PmMark = {
        name: string;
        startTime: number;
        duration: number;
        properties?: { kind?: string; viewCount?: number; bytes?: number; docName?: string };
      };
      // `marks` is a CircularBuffer; `.toArray()` returns a plain PmMark[].
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

    // Pair start/end. The expected sequence in a single revisit is exactly
    // [reparent-start, reparent-end]. If we see >1 of either, take the most
    // recent pair (LIFO).
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

    // ─── Post-measurement diagnostics. ──────────────────────────────────────
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
