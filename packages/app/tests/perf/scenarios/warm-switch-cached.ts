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
