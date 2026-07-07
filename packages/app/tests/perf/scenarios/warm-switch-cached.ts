/**
 * V2 warm-switch-cached scenario.
 *
 * Measures warm-switch wall-clock P95 between two cached (Activity-evicted
 * but editor-cached) docs. Target: < 200 ms prod P95.
 *
 * Workflow (this scenario exercises the wired
 * V2 cache via EditorActivityPool):
 *   1. Cold-load docA (small), then docB (small) — both get cache entries.
 *   2. Navigate to 2 other docs to push docA out of the Activity mount
 *      list (ACTIVITY_MOUNT_LIMIT=3). docA stays editor-cached; its
 *      provider is disconnected.
 *   3. Navigate back to docA — measure wall-clock until the cached
 *      Editor's DOM is reparented + focused + scrollTop restored.
 *
 * Until the V2 cache is wired into EditorActivityPool, running this
 * scenario measures the pre-V2 behavior (equivalent to existing
 * warm-switch.ts). The scenario file is the contract for
 * post-integration measurement.
 */

import { markerFor } from '../lib/doc-markers';
import { installLongtaskObserver } from '../lib/longtask-observer';
import { defineScenario } from '../lib/scenario';

const DOC_A = process.env.OK_PERF_DOC_A ?? 'README';
const DOC_B = process.env.OK_PERF_DOC_B ?? 'AGENTS';
const EVICT_DOCS_DEFAULT = ['STORIES', 'PROJECT'];
const EVICT_DOCS = (process.env.OK_PERF_EVICT_DOCS ?? EVICT_DOCS_DEFAULT.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const WAIT_CONTENT_MS = 60_000;

async function waitForVisibleProseMirrorForDoc(
  page: import('@playwright/test').Page,
  docName: string,
  timeoutMs: number,
): Promise<void> {
  const marker = markerFor(docName);
  if (!marker) return;
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
}

export default defineScenario({
  name: 'warm-switch-cached',
  description:
    'V2 G1 repro: warm-switch between two V2-cache-resident docs after their Activity entries are demoted.',

  async run(ctx) {
    const { page, opts } = ctx;

    await installLongtaskObserver(page);

    // Step 1: warm up docA + docB
    await page.goto(`${opts.target}/#/${encodeURIComponent(DOC_A)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    try {
      await waitForVisibleProseMirrorForDoc(page, DOC_A, WAIT_CONTENT_MS);
    } catch {
      ctx.note(`Step 1 failed: could not confirm ${DOC_A} content`);
      ctx.recordMetric('warmSwitchCachedMs', -1);
      return;
    }
    await page.goto(`${opts.target}/#/${encodeURIComponent(DOC_B)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    try {
      await waitForVisibleProseMirrorForDoc(page, DOC_B, WAIT_CONTENT_MS);
    } catch {
      ctx.note(`Step 2 failed: could not confirm ${DOC_B} content`);
      ctx.recordMetric('warmSwitchCachedMs', -1);
      return;
    }

    // Step 2: force Activity-mount eviction of docA
    for (const other of EVICT_DOCS) {
      await page.goto(`${opts.target}/#/${encodeURIComponent(other)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      try {
        await waitForVisibleProseMirrorForDoc(page, other, WAIT_CONTENT_MS);
      } catch {
        ctx.note(`eviction-walk failed on ${other} — proceeding`);
      }
    }

    // Step 3: navigate back to docA — V2 cache should reparent, not rebuild.
    const t0 = Date.now();
    await page.goto(`${opts.target}/#/${encodeURIComponent(DOC_A)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    try {
      await waitForVisibleProseMirrorForDoc(page, DOC_A, WAIT_CONTENT_MS);
    } catch {
      ctx.note(`Step 3 failed: could not confirm ${DOC_A} content after warm-switch`);
      ctx.recordMetric('warmSwitchCachedMs', -1);
      return;
    }
    const warmSwitchCachedMs = Date.now() - t0;

    ctx.recordMetric('docA', DOC_A);
    ctx.recordMetric('docB', DOC_B);
    ctx.recordMetric('warmSwitchCachedMs', warmSwitchCachedMs);
  },
});
