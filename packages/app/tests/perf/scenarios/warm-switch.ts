/**
 * Reproduction — warm switch-back to a previously-loaded small doc after
 * visiting a large doc.
 *
 * Workflow:
 *   1. Cold-load README (small, 5 KB).
 *   2. Navigate to PROJECT (large, multi-MB) — waits for PROJECT content.
 *   3. Click sidebar's README entry — measure wall-clock until README's
 *      visible ProseMirror is rendered with README-specific content.
 *
 * The user-visible symptom is "click a sidebar entry → noticeable hitch"
 * after visiting a big doc, so the scenario measures the full click→content
 * pipeline. The timing starts at the sidebar click and ends when the visible
 * editor contains README content — which is the user-perceived "switch
 * completed" moment.
 *
 * Pre-fix baseline: warmSwitchMs ≥ 500.
 * Post-fix target: warmSwitchMs < 100 AND README content continuity
 * preserved during the transition (precedent #18 G2 — verified by Playwright
 * E2E tests `docs-open.e2e.ts` which aren't re-run here, just not regressed).
 */

import { markerFor } from '../lib/doc-markers.ts';
import { installLongtaskObserver } from '../lib/longtask-observer.ts';
import { defineScenario } from '../lib/scenario.ts';

const SMALL_DOC = process.env.OK_PERF_SMALL_DOC ?? 'README';
const BIG_DOC = process.env.OK_PERF_BIG_DOC ?? 'perf-fixtures/big-doc';

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
    () => {
      const nodes = document.querySelectorAll('.ProseMirror');
      for (const n of Array.from(nodes)) {
        const rect = (n as HTMLElement).getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        if (visible && (n.textContent ?? '').length > 500) return true;
      }
      return false;
    },
    null,
    { timeout: timeoutMs },
  );
}

export default defineScenario({
  name: 'warm-switch',
  description:
    'S2 repro: click sidebar → switch back to a warm small doc after visiting a big doc.',

  async run(ctx) {
    const { page, opts } = ctx;

    await installLongtaskObserver(page);

    await page.goto(`${opts.target}/#/${encodeURIComponent(SMALL_DOC)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    try {
      await waitForVisibleProseMirrorForDoc(page, SMALL_DOC, WAIT_CONTENT_MS);
    } catch {
      ctx.note(`Step 1 failed: could not confirm ${SMALL_DOC} content`);
      ctx.recordMetric('warmSwitchMs', -1);
      return;
    }

    await page.goto(`${opts.target}/#/${encodeURIComponent(BIG_DOC)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    try {
      await waitForVisibleProseMirrorForDoc(page, BIG_DOC, WAIT_CONTENT_MS);
    } catch {
      ctx.note(`Step 2 failed: could not confirm ${BIG_DOC} content`);
      ctx.recordMetric('warmSwitchMs', -1);
      return;
    }

    await page.waitForTimeout(250);

    const sidebar = page.locator('[data-slot="sidebar-container"]');
    const smallDocRow = sidebar.getByText(`${SMALL_DOC}.md`, { exact: true });

    await smallDocRow.waitFor({ state: 'visible', timeout: 10_000 });

    const clickAt = Date.now();
    await smallDocRow.click({ timeout: 10_000 });

    try {
      await waitForVisibleProseMirrorForDoc(page, SMALL_DOC, WAIT_CONTENT_MS);
    } catch {
      ctx.note('Step 3 failed: could not confirm switch-back content');
      ctx.recordMetric('warmSwitchMs', -1);
      return;
    }
    const warmSwitchMs = Date.now() - clickAt;

    ctx.recordMetric('smallDoc', SMALL_DOC);
    ctx.recordMetric('bigDoc', BIG_DOC);
    ctx.recordMetric('warmSwitchMs', warmSwitchMs);
  },
});
