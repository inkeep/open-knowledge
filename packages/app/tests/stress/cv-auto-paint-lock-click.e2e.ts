/**
 * Renderer-survival pin for the SECOND display-lock site: `.ok-chunk-wrapper`
 * (`content-visibility: auto`), which `cv-paint-lock-click.e2e.ts` leaves
 * explicitly unpinned.
 *
 * Blink hard-CHECKs (`third_party/blink/renderer/core/layout/hit_test_result.cc`,
 * `LockedAncestorPreventingPaint` inside `HitTestResult::GetPosition()`) when a
 * mouse press's hit-tested node has a paint-blocked ANCESTOR at the moment the
 * click's default selection resolution reads a caret position out of the
 * already-captured hit result. The whole renderer dies; the desktop shell
 * auto-reloads the window, which users experience as an app reboot. Note the
 * asymmetry that makes this a crash rather than a no-op: one line below the
 * CHECK, Blink returns gracefully when the hit node's own CHILDREN are
 * lock-blocked. Only the ancestor case aborts.
 *
 * `.ok-mode-hidden` (`content-visibility: hidden`) is the site the sibling test
 * pins. This file covers the other one: OK stamps `.ok-chunk-wrapper` on EVERY
 * top-level ProseMirror block (`chunk-wrapper-decoration.ts`) with a bare
 * `content-visibility: auto` and no deferral.
 *
 * A field renderer crash landed on exactly that CHECK, on a build that already
 * carried the `.ok-mode-hidden` fix, with a recovered stack showing the click
 * dispatched as RAF-aligned input from inside `BeginMainFrame` — the input
 * dispatch happening *within* a rendering update.
 *
 * WHY THE CRASH NEEDS A DESCENDANT HIT. A locked cv:auto wrapper does not lay
 * out its contents, so a hit inside it resolves to the wrapper itself and takes
 * the graceful child-blocked path. The CHECK is only reachable if the hit test
 * resolves to a DESCENDANT while the wrapper is unlocked, and the wrapper then
 * locks before the caret is read.
 *
 * WHAT IS AND IS NOT OBSERVABLE FROM A TEST. The window between the hit result
 * being captured and `GetPosition()` reading it is real, and script plus several
 * forced style/layout flushes run inside it. But the two ways a cv:auto element
 * can lock behave differently there:
 *
 *   - Intersection-driven (scrolling it out of the render margin) cannot land in
 *     the window. The mousedown path's flushes stop at pre-paint, before the
 *     post-layout intersection-observer step, and a scroll only marks
 *     intersection state dirty rather than delivering synchronously. CSS
 *     Contain 2 corroborates: skipped-state updates are deferred to the
 *     rendering update's own step, so a forced `offsetHeight` cannot deliver a
 *     relevance change.
 *   - Style-driven can, in principle: a newly created display-lock context
 *     starts with its viewport-intersection flag false, so applying cv:auto to
 *     an element that did not have it locks it during the next style recalc,
 *     even fully on-screen.
 *
 * NO TEST HERE CAN PROVE A LOCK DID NOT COMMIT INSIDE THE DISPATCH, and this
 * file deliberately does not claim to. `contentvisibilityautostatechange` is
 * dispatched by POSTING A TASK, not inline with the lock flip
 * (`DisplayLockContext::ScheduleStateChangeEventIfNeeded`), so run-to-completion
 * guarantees it lands after any synchronous handler finishes. An earlier draft
 * timed the event against a window stamped inside the handler and asserted the
 * count was zero; that assertion was structurally incapable of failing and has
 * been removed rather than left to read as evidence.
 *
 * THE SAFETY PROPERTY THIS FILE DISCOVERED AND NOW PINS. A clicked block cannot
 * enter the cv:auto paint lock at all, because the click places the caret in it
 * and `content-visibility: auto` keeps a selection-containing element relevant
 * to the user indefinitely. The committed arm measures this within-subject:
 * scrolled two viewports away UNCLICKED the target locks; clicked first and
 * scrolled FOUR TIMES that distance it does not, while dozens of sibling blocks
 * lock in the same run. (An investigation run, not committed here, also found
 * no lock for a clicked block at the control's own two viewports — so the
 * result is not an artifact of the larger distance.) So it is the selection
 * pin, not scroll distance. That
 * pin is what keeps this site safe, it is a Chromium behavior rather than
 * anything OK controls, and the first test below fails loudly if a future
 * Chromium drops it.
 *
 * PRECONDITIONS ARE MEASURED, NOT ASSUMED. `landing.ts` warns that "whether
 * Chromium actually skips an off-screen chunk in a headless run is a runtime
 * decision", and a green here would be worthless if nothing ever locked. Two
 * plausible oracles are blind and must not be used. Measured, not reasoned:
 * the box-height probe `landing.ts` uses for materialization reported a
 * non-zero child height for EVERY block, including one 12,543px off-screen —
 * so it cannot distinguish skipped from painted here. (The mechanism behind
 * that is not established. Reading a descendant's rect inside a skipped
 * subtree plausibly forces the layout it is trying to observe, but this file
 * does not claim that; what it relies on is the observation.) Separately,
 * `Element.checkVisibility({contentVisibilityAuto:true})`
 * reported 0 skipped of 389 off-screen wrappers because it answers about the
 * wrapper, which stays visible while its CONTENTS are skipped. The spec'd
 * `contentvisibilityautostatechange` event is the honest signal for WHETHER a
 * relevance flip happened, with the caveat above that it cannot time one.
 * Measured on this harness (400-block doc): a mid-document scroll jump produces
 * 42 `skipped: true` transitions, identically headless and headed — so headless
 * is a faithful substrate and this pin belongs in CI.
 *
 * WHAT WAS TRIED AND SURVIVED. Six shapes, all leaving the renderer alive:
 * scrolling the clicked block out of relevance mid-dispatch; applying a fresh
 * cv:auto to an on-screen ancestor inside the capture-phase mousedown; a
 * remove/flush/re-add of the app's own wrapper class (the shape a ProseMirror
 * decoration recompute produces); an `auto -> visible -> flush -> auto`
 * retoggle; clicks under scroll churn on a congested main thread; and
 * CDP-batched move+press so the press dispatches from inside `BeginMainFrame`.
 * None reproduced the CHECK. Note for anyone re-running these: removing and
 * re-adding a cv:auto class inside ONE task is a no-op, because Blink's
 * requested-state setter early-returns when the computed value did not change.
 * An experiment built that way tests nothing and reads exactly like proof of
 * safety.
 *
 * This seam only exists in a real Chromium layout/paint engine — jsdom has no
 * display-lock machinery — so the pin lives at Playwright fidelity.
 *
 * WHY THIS FILE OPTS OUT OF THE SUITE'S CI RETRIES. `playwright.config.ts` sets
 * `retries: isCI ? 2 : 0` with `failOnFlakyTests: false`, so in CI a test runs
 * up to three times and failed-then-passed is classified flaky and let through.
 * For an intermittent renderer abort that masks almost everything: the run goes
 * red only when the crash reproduces on ALL THREE attempts, and two-of-three is
 * hidden exactly as thoroughly as one-of-three. The file therefore calls
 * `test.describe.configure({ retries: 0 })` below, making CI behave the way
 * local already did — one reproduction fails the run.
 *
 * The exposure was never total, and the record should not imply it was.
 * A daily scheduled CI job already drives this same `test:e2e` task at
 * `--repeat-each=3 --retries=0`, and its own comment calls `--retries=0`
 * load-bearing for exactly this reason. (It is named in `precedent #20(e)`
 * rather than here: it lives in the monorepo's root workflow tree, which is not
 * part of this mirror, so the filename would not resolve for a reader who has
 * only the public repo.) Three unretried
 * attempts a day is arguably a stronger detector for a probabilistic abort than
 * the single PR-tier attempt this override creates. What the override actually
 * buys is PR-tier BLOCKING rather than next-day advisory, which matters because a
 * merged renderer-crash regression rides the beta cadence out to users before the
 * daily run fires.
 *
 * The opt-out is per-file on purpose. The suite-wide settings are load-bearing:
 * their own comment in `playwright.config.ts` records that turning
 * `failOnFlakyTests` on globally promoted WebSocket and CRDT-broadcast noise to
 * PR-red and cut the PR-tier green rate to roughly 22% on correct code. Those
 * retries absorb infrastructure flake, which is what they are for. A renderer
 * crash is not infrastructure flake, so this file — and only this file — treats
 * a single occurrence as fatal. The sibling `.ok-mode-hidden` pin does NOT need
 * the same treatment: its header records that it reproduces its timing
 * deterministically, so a regression there fails all three attempts anyway and
 * retries cannot mask it. Do not spread this policy on symmetry alone.
 *
 * WHAT THE OPT-OUT ALSO MAKES FATAL. The mechanism is per file, not per failure
 * mode, so it is not only the crash that stops being retried. `setupTallDoc`'s
 * seeding and provider sync, `stageTargetForClick`'s convergence bound, and the
 * lock-event settle waits in two of the three tests all become
 * single-occurrence-fatal too, and those are precisely the WebSocket and
 * CRDT-broadcast classes the retries were absorbing. Two more join them. The
 * file's `test.use({ trace })` is a WORKER-scoped option, so it partitions the
 * worker pool and this file can never land on an already-booted worker: it
 * always pays a fresh `workerServer` boot (Vite, Hocuspocus, a `mkdtemp`
 * contentDir and a warmup load), and that boot is now unretried as well. This
 * is the same partitioning the `workerServerEnv` files already accept, so it is
 * precedented rather than novel, but it was previously amortizable and is not
 * any more. And `pressAndProbe` resolves ANY renderer death to
 * `renderer-crashed`, so a host-pressure or OOM kill is indistinguishable here
 * from the abort being hunted and now fails the PR on first occurrence wearing
 * the hunted crash's face.
 *
 * That is the price, accepted knowingly: a crash reported green is a
 * worse failure for this file than a setup flake reported red, and three tests
 * over one document is a small surface to pay it on. If this file starts going
 * red on seeding or sync rather than on a hit-test abort, harden the setup —
 * do not restore the retries, which would re-hide the crash along with the noise.
 *
 * TRACE, AND WHAT A RED RUN ACTUALLY LEAVES. Zero retries makes the suite's
 * `trace: 'on-first-retry'` unreachable here, so the file sets
 * `retain-on-failure` instead. That is not a nicety on this pin: measured on
 * 1.59.1 by crashing a renderer with real page content loaded, a dead renderer
 * CANNOT be screenshotted. An identical failure with the renderer alive leaves
 * `test-failed-1.png`; kill the renderer first and the screenshot is simply
 * absent, while `trace.zip` and `video.webm` both survive. On the one failure
 * path this file exists to catch, trace is therefore the richest artifact that
 * still exists rather than a luxury on top of a screenshot.
 *
 * The churn arm pays for this and keeps it anyway. Tracing costs tests one and
 * two 13% and 18%, but takes the churn arm from 3.4s to 7.5s across three runs,
 * because it congests the main thread on purpose and snapshotting adds to that
 * congestion. Measured rather than assumed: with tracing on, all three still
 * pass and the churn arm's own precondition still holds, so the extra load makes
 * that arm slower without making it invalid. The DECLARATIVE option cannot be
 * scoped below file level: `trace` is worker-scoped, so `test.use({ trace })`
 * inside a `test.describe` is rejected outright ("forces a new worker"). That
 * leaves file-wide or nothing among the config-driven shapes. Playwright's
 * manual `context.tracing.start/stop` API is test-scoped and would allow per-arm
 * tracing, at the cost of hand-wiring output paths and losing the HTML report's
 * automatic trace linkage; it was judged not worth that for three tests, not
 * ruled impossible. File-wide wins because
 * the alternative gives up the only rich artifact that survives the crash.
 *
 * This narrows `precedent #20(e)`'s "every CI failure is debuggable from
 * artifacts alone" here only in that a crash leaves no screenshot, which is a
 * property of dead renderers rather than of this override. #20(e) records the
 * carve-out this file establishes.
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
