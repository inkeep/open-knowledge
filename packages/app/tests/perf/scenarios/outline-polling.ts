/**
 * OutlinePanel polls `/api/page-headings` every 2s while
 * mounted. The scenario opens README, waits for the outline panel to mount
 * and fire its first heading fetch, then sits idle for 30s and counts the
 * number of background `/api/page-headings` requests that fire during the
 * idle window.
 *
 * Pre-fix baseline: apiCallCount ≥ 10 across 30s idle.
 * Post-fix target:  apiCallCount === 0 across 30s idle (invalidation
 * moves to HocuspocusProvider `update` event).
 *
 * The scenario uses its own `page.on('response')` listener so it can filter
 * by absolute Date.now() timestamps — the driver's `networkRequests` array
 * only carries request-duration ms, not absolute timestamps, so it cannot
 * answer "how many requests in THIS 30s window".
 */

import { installLongtaskObserver } from '../lib/longtask-observer';
import { defineScenario } from '../lib/scenario';

const DOC = 'README';
const IDLE_MS = 30_000;
const HEADINGS_API = '/api/page-headings';

export default defineScenario({
  name: 'outline-polling',
  description:
    'S4 repro: measure /api/page-headings request count over a 30s idle window after README loads.',

  async run(ctx) {
    const { page, opts } = ctx;

    await installLongtaskObserver(page);

    const headingRequestsAt: number[] = [];
    page.on('response', (resp) => {
      if (resp.url().includes(HEADINGS_API)) {
        headingRequestsAt.push(Date.now());
      }
    });

    await page.goto(`${opts.target}/#/${encodeURIComponent(DOC)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    try {
      await page.waitForSelector('.ProseMirror', { state: 'attached', timeout: 60_000 });
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.ProseMirror');
          return Boolean(el && (el.textContent ?? '').length > 50);
        },
        null,
        { timeout: 60_000 },
      );
    } catch {
      ctx.note('Editor did not render — aborting idle measurement');
      ctx.recordMetric('apiCallCount', -1);
      return;
    }

    // Wait for at least the initial heading fetch to fire so we know the
    // OutlinePanel is mounted and active. If it never fires within 10s the
    // panel may be collapsed or absent; either way the idle window still
    // measures background polling from zero.
    const startAwaitFirst = Date.now();
    while (headingRequestsAt.length === 0 && Date.now() - startAwaitFirst < 10_000) {
      await page.waitForTimeout(200);
    }
    const initialCount = headingRequestsAt.length;
    if (initialCount === 0) {
      ctx.note('OutlinePanel did not fire an initial /api/page-headings within 10s');
    }

    // 30s idle — deliberately no interaction. This is measurement, not a test.
    const idleStart = Date.now();
    await page.waitForTimeout(IDLE_MS);
    const idleEnd = Date.now();

    const idleHits = headingRequestsAt.filter((t) => t > idleStart && t <= idleEnd);

    ctx.recordMetric('docName', DOC);
    ctx.recordMetric('idleMs', idleEnd - idleStart);
    ctx.recordMetric('initialRequestCount', initialCount);
    ctx.recordMetric('apiCallCount', idleHits.length);
    ctx.recordMetric('expectedPollIntervalMs', 2000);
  },
});
