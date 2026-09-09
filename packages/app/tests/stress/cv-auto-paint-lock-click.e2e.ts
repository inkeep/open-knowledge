/**
 * Renderer-survival pin for the `.ok-chunk-wrapper` (`content-visibility: auto`) display-lock
 * site the sibling test leaves unpinned: a click whose hit-tested node has a paint-blocked
 * ancestor kills the renderer. Per-test docName isolation per precedent #20(a).
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  blockMarker,
  expect,
  generateTallDoc,
  scrollWysiwygBlockToTop,
  test,
  waitForActiveProviderSynced,
} from './_helpers';

test.describe.configure({ retries: 0 });
test.use({ trace: 'retain-on-failure' });

const WYSIWYG = '.ProseMirror:not(.composer-prosemirror)';
const CHUNK_WRAPPER = `${WYSIWYG} .ok-chunk-wrapper`;
const SCROLLER = '[data-testid="editor-scroll-container"]';

const BLOCK_COUNT = 400;
const TARGET_INDEX = 150;
const MARKER_LENGTH = 9;
const SETTLE_TIMEOUT_MS = 15_000;
const SETTLE_POLL_INTERVAL_MS = 100;
const CHURN_CLICK_COUNT = 20;

type ClickOutcome = 'alive' | 'renderer-crashed';

interface LockEvent {
  marker: string;
  skipped: boolean;
}

interface LockReport {
  events: LockEvent[];
  skippedCount: number;
  armRan: boolean;
}

interface CvRecorder {
  events: LockEvent[];
  armRan: boolean;
}

async function trackLockTransitions(page: Page): Promise<void> {
  await page.evaluate(
    ({ wrapperSelector, markerLength }) => {
      const w = window as unknown as { __cv: CvRecorder; __cvBound?: boolean };
      w.__cv = { events: [], armRan: false };
      if (w.__cvBound) return;
      w.__cvBound = true;
      for (const el of document.querySelectorAll<HTMLElement>(wrapperSelector)) {
        const marker = (el.textContent ?? '').slice(0, markerLength);
        el.addEventListener('contentvisibilityautostatechange', (ev) => {
          w.__cv.events.push({ marker, skipped: (ev as Event & { skipped: boolean }).skipped });
        });
      }
    },
    { wrapperSelector: CHUNK_WRAPPER, markerLength: MARKER_LENGTH },
  );
}

async function readLockReport(page: Page): Promise<LockReport> {
  return page.evaluate(() => {
    const w = window as unknown as { __cv?: CvRecorder };
    if (!w.__cv) throw new Error('readLockReport: lock tracking was never installed');
    return {
      events: w.__cv.events,
      skippedCount: w.__cv.events.filter((e) => e.skipped).length,
      armRan: w.__cv.armRan,
    };
  });
}

async function lockEventCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __cv?: CvRecorder };
    return w.__cv?.events.length ?? 0;
  });
}

const REQUIRED_STABLE_SAMPLES = 5;

async function waitForLockTransitionsToSettle(page: Page, since: number): Promise<void> {
  let previous = -1;
  let stable = 0;
  await expect
    .poll(
      async () => {
        const now = await lockEventCount(page);
        stable = now > since && now === previous ? stable + 1 : 0;
        previous = now;
        return stable;
      },
      {
        timeout: SETTLE_TIMEOUT_MS,
        intervals: [SETTLE_POLL_INTERVAL_MS],
        message: 'cv:auto relevance transitions never arrived, or never stopped arriving',
      },
    )
    .toBeGreaterThanOrEqual(REQUIRED_STABLE_SAMPLES);
}

async function setupTallDoc(page: Page, api: ApiHelpers): Promise<void> {
  const docName = `test-cvauto-${randomUUID().slice(0, 8)}`;
  const { markdown } = generateTallDoc({ blockCount: BLOCK_COUNT });
  await api.seedDocs([{ name: docName, markdown }]);
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator(WYSIWYG).first()).toBeVisible();
}

async function stageTargetForClick(page: Page, marker: string): Promise<void> {
  const settleDelta = await scrollWysiwygBlockToTop(page, marker);
  expect(
    Math.abs(settleDelta),
    `setup scroll did not converge block "${marker}" to the readable top`,
  ).toBeLessThan(40);
}

async function scrollAway(page: Page, viewports: number): Promise<number> {
  const before = await lockEventCount(page);
  const moved = await page.evaluate(
    ({ scrollSelector, viewports }) => {
      const s = Array.from(document.querySelectorAll<HTMLElement>(scrollSelector)).find(
        (el) => el.getClientRects().length > 0,
      );
      if (!s) throw new Error('scrollAway: no visible scroll container');
      const from = s.scrollTop;
      s.scrollTop += s.clientHeight * viewports;
      return s.scrollTop - from;
    },
    { scrollSelector: SCROLLER, viewports },
  );
  await waitForLockTransitionsToSettle(page, before);
  return moved;
}

async function pressAndProbe(page: Page, x: number, y: number): Promise<ClickOutcome> {
  let onCrash: (() => void) | undefined;
  const crashed = new Promise<ClickOutcome>((resolve) => {
    onCrash = () => resolve('renderer-crashed');
    page.on('crash', onCrash);
  });
  try {
    const clickAndProbe = (async (): Promise<ClickOutcome> => {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.up();
      await page.evaluate(() => document.readyState);
      return 'alive';
    })().catch((): ClickOutcome => 'renderer-crashed');
    return await Promise.race([crashed, clickAndProbe]);
  } finally {
    if (onCrash) page.off('crash', onCrash);
  }
}

async function pointInsideBlockText(page: Page, marker: string): Promise<{ x: number; y: number }> {
  const box = await page.evaluate(
    ({ marker, wrapperSelector }) => {
      const wrapper = Array.from(document.querySelectorAll<HTMLElement>(wrapperSelector)).find(
        (w) => w.textContent?.includes(marker),
      );
      if (!wrapper) throw new Error(`pointInsideBlockText: block "${marker}" not in the DOM`);
      const probe = wrapper.firstElementChild ?? wrapper;
      const r = probe.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
    { marker, wrapperSelector: CHUNK_WRAPPER },
  );
  if (box.height <= 0 || box.width <= 0) {
    throw new Error(
      `pointInsideBlockText: block "${marker}" has an empty box (${JSON.stringify(box)})`,
    );
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('PRD-8158: a clicked .ok-chunk-wrapper stays out of the cv:auto paint lock', async ({
  page,
  api,
}) => {
  await setupTallDoc(page, api);
  const targetMarker = blockMarker(TARGET_INDEX);

  await stageTargetForClick(page, targetMarker);
  await trackLockTransitions(page);
  const controlDistance = await scrollAway(page, 2);
  const control = await readLockReport(page);
  expect(
    control.events.filter((e) => e.marker === targetMarker && e.skipped).length,
    `control failed: block "${targetMarker}" did not enter a cv:auto paint lock even unclicked, so this run cannot tell a selection pin from an inert page`,
  ).toBeGreaterThan(0);

  await stageTargetForClick(page, targetMarker);
  await trackLockTransitions(page);
  const point = await pointInsideBlockText(page, targetMarker);
  const outcome = await pressAndProbe(page, point.x, point.y);
  expect(outcome, 'renderer must survive an ordinary click into a chunk wrapper').toBe('alive');
  const clickedDistance = await scrollAway(page, 8);

  expect(
    clickedDistance,
    'the post-click scroll was clamped to near the control distance, so this phase no longer distinguishes a selection pin from simply not having travelled far enough',
  ).toBeGreaterThan(controlDistance * 2);

  const after = await readLockReport(page);
  expect(
    after.skippedCount,
    'no wrapper at all entered a cv:auto paint lock after the click — the page went inert, so the selection-pin assertion would be vacuous',
  ).toBeGreaterThan(0);
  expect(
    after.events.filter((e) => e.marker === targetMarker && e.skipped).length,
    `the clicked block "${targetMarker}" entered a cv:auto paint lock. Chromium no longer keeps a ` +
      'selection-containing element relevant, which is the property that currently keeps this site ' +
      "safe: a click's hit test resolves to a descendant, and a wrapper that can lock afterwards " +
      'reopens the display-lock CHECK. Harden .ok-chunk-wrapper with the same deferral trio ' +
      '.ok-mode-hidden carries.',
  ).toBe(0);
});

test('PRD-8158: a click survives its chunk wrapper being scrolled out of relevance mid-dispatch', async ({
  page,
  api,
}) => {
  await setupTallDoc(page, api);
  const targetMarker = blockMarker(TARGET_INDEX);
  await stageTargetForClick(page, targetMarker);
  await trackLockTransitions(page);

  await page.evaluate(
    ({ scrollSelector }) => {
      const scroller = Array.from(document.querySelectorAll<HTMLElement>(scrollSelector)).find(
        (el) => el.getClientRects().length > 0,
      );
      if (!scroller) throw new Error('no visible scroll container');
      const w = window as unknown as { __cv: CvRecorder };
      window.addEventListener(
        'mousedown',
        () => {
          w.__cv.armRan = true;
          scroller.scrollTop += scroller.clientHeight * 2;
          void scroller.offsetHeight;
        },
        { capture: true, once: true },
      );
    },
    { scrollSelector: SCROLLER },
  );

  const before = await lockEventCount(page);
  const point = await pointInsideBlockText(page, targetMarker);
  const outcome = await pressAndProbe(page, point.x, point.y);
  expect(
    outcome,
    'renderer must survive a click whose .ok-chunk-wrapper is scrolled out of cv:auto relevance during the same dispatch',
  ).toBe('alive');

  await waitForLockTransitionsToSettle(page, before);
  const report = await readLockReport(page);
  expect(report.armRan, 'no mousedown was dispatched to the page, so the arm never ran').toBe(true);
  expect(
    report.skippedCount,
    'the scroll drove no wrapper into a cv:auto paint lock, so this run exercised nothing',
  ).toBeGreaterThan(0);
});

test('PRD-8158: rapid clicks during scroll churn survive cv:auto relevance flips on a congested main thread', async ({
  page,
  api,
}) => {
  await setupTallDoc(page, api);
  const targetMarker = blockMarker(TARGET_INDEX);
  await stageTargetForClick(page, targetMarker);
  await trackLockTransitions(page);

  await page.evaluate(
    ({ scrollSelector }) => {
      const scroller = Array.from(document.querySelectorAll<HTMLElement>(scrollSelector)).find(
        (el) => el.getClientRects().length > 0,
      );
      if (!scroller) throw new Error('no visible scroll container');
      const w = window as unknown as { __churn: number; __churnStop?: () => void };
      w.__churn = 0;
      let direction = 1;
      let running = true;
      w.__churnStop = () => {
        running = false;
      };
      const step = (): void => {
        if (!running) return;
        const until = performance.now() + 12;
        while (performance.now() < until) {}
        scroller.scrollTop += direction * scroller.clientHeight;
        const maxScroll = scroller.scrollHeight - scroller.clientHeight;
        if (scroller.scrollTop <= 0 || scroller.scrollTop >= maxScroll) direction *= -1;
        w.__churn += 1;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    { scrollSelector: SCROLLER },
  );

  const band = await page.evaluate(
    ({ scrollSelector }) => {
      const scroller = Array.from(document.querySelectorAll<HTMLElement>(scrollSelector)).find(
        (el) => el.getClientRects().length > 0,
      );
      if (!scroller) throw new Error('no visible scroll container');
      const r = scroller.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), top: Math.round(r.top + 80), height: r.height };
    },
    { scrollSelector: SCROLLER },
  );

  let outcome: ClickOutcome = 'alive';
  const span = Math.max(1, Math.round(band.height - 160));
  for (let i = 0; i < CHURN_CLICK_COUNT && outcome === 'alive'; i++) {
    outcome = await pressAndProbe(page, band.x, band.top + ((i * 37) % span));
  }
  expect(
    outcome,
    'renderer must survive clicks landing while .ok-chunk-wrapper blocks flip cv:auto relevance under a congested main thread',
  ).toBe('alive');

  await page.evaluate(() => {
    (window as unknown as { __churnStop?: () => void }).__churnStop?.();
  });

  const churn = await page.evaluate(() => (window as unknown as { __churn: number }).__churn);
  expect(
    churn,
    'the scroll-churn loop never ran — no relevance flips were provoked',
  ).toBeGreaterThan(10);
  const report = await readLockReport(page);
  expect(
    report.skippedCount,
    'no wrapper entered a cv:auto paint lock during the churn — the precondition was never built, so a pass here would be vacuous',
  ).toBeGreaterThan(0);
  expect(
    report.events.some((e) => e.marker === targetMarker),
    `the staged block "${targetMarker}" never changed cv:auto relevance — the churn did not reach it`,
  ).toBe(true);
});
