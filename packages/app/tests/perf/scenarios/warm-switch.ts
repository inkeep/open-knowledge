import { markerFor } from '../lib/doc-markers';
import { installLongtaskObserver } from '../lib/longtask-observer';
import { defineScenario } from '../lib/scenario';

const SMALL_DOC = process.env.OK_PERF_SMALL_DOC ?? 'README';
const BIG_DOC = process.env.OK_PERF_BIG_DOC ?? 'PROJECT';

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
