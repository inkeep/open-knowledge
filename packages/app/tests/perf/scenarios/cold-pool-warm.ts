/**
 * Cold-pool-warm reproduction — target the specific state where the big-doc
 * is provider-pool-resident but Activity-evicted, so revisiting it forces
 * a fresh TipTap mount without the provider/Y.Doc re-sync.
 *
 * Rationale: the ~9.7s single-main-thread-task cost was measured on this
 * state, not a fresh cold-load. A fresh cold-load ALSO pays Y.Doc sync cost
 * (instrumentation has measured it at 1.7-2.3s).
 * "Cold-pool-warm" isolates the TipTap+PM+React cost from the Y.Doc sync.
 *
 * Scenario flow:
 *   1. Cold-load README (small, 5 KB) — warms ProviderPool for README.
 *   2. Navigate to BIG_DOC (large) — warms pool for BIG_DOC, mounts Activity
 *      entry for BIG_DOC.
 *   3. Navigate to 3 OTHER docs (to force Activity eviction of BIG_DOC via
 *      ACTIVITY_MOUNT_LIMIT=3). BIG_DOC's provider stays pool-resident.
 *   4. Navigate BACK to BIG_DOC — measure time until PM content visible.
 *
 * The measured boundary is step 4. BIG_DOC's provider is still pool-resident
 * (ytext already hydrated), so the measurement is:
 *   [useState lazy init (new Editor → new EditorView → _forceRerender → docView)
 *    → React commit → EditorContent.init (createNodeViews) → portal reconcile →
 *    browser layout/paint]
 *
 * No Y.Doc sync on this path. Any difference vs `cold-load-big-doc` is the
 * sync cost. The monkey-patched `ok/cold/*` marks decompose the TipTap/PM/React
 * cost within this window.
 *
 * Regression-gate invocation (canonical):
 *   OK_PERF_BIG_DOC=STORIES bun run perf:profile --scenario=cold-pool-warm
 *
 * STORIES is the designated reference doc (≈176 MarkView portals, fits
 * the ≤200-view target band). Baseline: 541 ms. Target:
 * < 300 ms. Depends on doc-markers.ts entry for STORIES — without it the
 * scenario falls through to a content-length heuristic that races against
 * still-Activity-mounted previous docs and produces pmLen numbers matching
 * the wrong editor.
 *
 * Default (BIG_DOC=PROJECT) is a 768-view stress case used for attribution
 * measurements and precedent #27 validation — informative but outside the
 * regression-gate target scope. Use it for "how bad was the worst case" and
 * the STORIES invocation for "does the current code still hit the gate."
 */

import { markerFor } from '../lib/doc-markers';
import { installLongtaskObserver, readLongtasks } from '../lib/longtask-observer';
import { defineScenario } from '../lib/scenario';

const BIG_DOC = process.env.OK_PERF_BIG_DOC ?? 'PROJECT';
const WARM_DOC = process.env.OK_PERF_SMALL_DOC ?? 'README';

// A list of small doc names used to force Activity eviction. We want >= 3
// distinct docs (ACTIVITY_MOUNT_LIMIT default) so visiting all of them
// pushes PROJECT off the mount list even though it stays pool-resident.
// Defaults to well-known small docs in this repo; override via env if needed.
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

    // ─── Step 1: cold-load WARM_DOC so app + ProviderPool exist. ───────────
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

    // ─── Step 2: cold-load BIG_DOC — hydrates provider + Activity mount. ───
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

    // Capture sanity metrics on the loaded BIG_DOC
    const pmLenAfterCold = await page.evaluate(() => {
      const el = document.querySelector('.ProseMirror');
      return el ? (el.textContent ?? '').length : 0;
    });
    ctx.recordMetric('pmLenAfterCold', pmLenAfterCold);

    // Extract ytext size from the pool provider so downstream analysis has it
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

    // ─── Step 3: navigate to EVICT_DOCS so PROJECT falls out of Activity. ──
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

    // Let any background work settle before the cold-pool-warm measurement.
    await page.waitForTimeout(500);

    // Reset counter / mark-store baselines so the `ok/cold/*` marks in the
    // result correspond cleanly to the measured boundary. Marks from earlier
    // steps are still in the collector but the scenario caller can filter by
    // `startTime >= revisitStartPerf`.
    const revisitStartPerf = await page.evaluate(() => performance.now());
    ctx.recordMetric('revisitStartPerf', revisitStartPerf);

    // ─── Step 4: navigate BACK to PROJECT. Measure remount cost. ───────────
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

    // ─── Post-measurement diagnostics ───────────────────────────────────────
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

    // Sanity: content should be visible
    const pmLenAfterRevisit = await page.evaluate(() => {
      const el = document.querySelector('.ProseMirror');
      return el ? (el.textContent ?? '').length : 0;
    });
    ctx.recordMetric('pmLenAfterRevisit', pmLenAfterRevisit);

    // Confirm instrumentation installed
    const instrumented = await page.evaluate(
      () =>
        (globalThis as unknown as { __okColdMountInstrumented?: boolean })
          .__okColdMountInstrumented ?? false,
    );
    ctx.recordMetric('coldMountInstrumented', instrumented);
  },
});
