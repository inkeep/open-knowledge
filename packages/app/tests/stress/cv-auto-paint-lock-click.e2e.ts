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
 * KNOWN EXPOSURE IN CI ONLY, RECORDED RATHER THAN FIXED. `playwright.config.ts`
 * sets `retries: isCI ? 2 : 0` and `failOnFlakyTests: false` unconditionally.
 * In CI a test therefore runs up to three times, Playwright classifies
 * failed-then-passed as flaky rather than failed, and flaky is let through — so
 * the run goes red only when the crash reproduces on ALL THREE attempts.
 * Anything short of that is masked equally: two-of-three is hidden exactly as
 * thoroughly as one-of-three. Locally retries are 0 and a single crash fails
 * the run outright, so a local green is exactly as strong as it looks.
 *
 * What that means in practice: a red run from this file is strong evidence, and
 * a green CI run is weaker than it looks for an intermittent crash. It is
 * recorded rather than special-cased because a per-file `retries: 0` is a
 * policy call for the suite's owners, not something this pin should make
 * unilaterally — and the sibling `.ok-mode-hidden` pin has carried the same
 * exposure since it landed.
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

const WYSIWYG = '.ProseMirror:not(.composer-prosemirror)';
const CHUNK_WRAPPER = `${WYSIWYG} .ok-chunk-wrapper`;
const SCROLLER = '[data-testid="editor-scroll-container"]';

/**
 * Tall enough that blocks away from the viewport genuinely leave the cv:auto
 * render margin — the scale the landing tests rely on for honest virtualization.
 * Much below this nothing ever locks and every arm would pass vacuously.
 */
const BLOCK_COUNT = 400;
/** Mid-document target: far from both ends, so neither edge special-cases it. */
const TARGET_INDEX = 150;
/** Marker text length (`OKBLK####`), the key lock transitions are recorded under. */
const MARKER_LENGTH = 9;
/** Budget for a scroll's relevance transitions to arrive and stop arriving. */
const SETTLE_TIMEOUT_MS = 15_000;
/**
 * Poll cadence for that wait. With `REQUIRED_STABLE_SAMPLES`, this is what
 * makes the accepted quiescence window an explicit half-second rather than
 * whatever `expect.poll`'s default backoff happens to produce.
 */
const SETTLE_POLL_INTERVAL_MS = 100;
/**
 * Clicks the churn arm lands while wrappers flip relevance underneath them.
 *
 * Named rather than inlined because `pressAndProbe`'s listener-cleanup rationale
 * depends on this being more than a couple — it is repeated presses against one
 * `Page` that turn a leaked `crash` listener into log noise. A bare literal in
 * the loop would let the two drift apart, and this value has already moved once.
 */
const CHURN_CLICK_COUNT = 20;

type ClickOutcome = 'alive' | 'renderer-crashed';

interface LockEvent {
  marker: string;
  skipped: boolean;
}

interface LockReport {
  events: LockEvent[];
  /** Transitions into the locked state, across all wrappers. */
  skippedCount: number;
  /** Whether the capture-phase arm ran at all. */
  armRan: boolean;
}

/** Shape of the page-context recorder the helpers below read and write. */
interface CvRecorder {
  events: LockEvent[];
  armRan: boolean;
}

/** Install (or reset) cv:auto transition recording on every chunk wrapper. */
async function trackLockTransitions(page: Page): Promise<void> {
  await page.evaluate(
    ({ wrapperSelector, markerLength }) => {
      const w = window as unknown as { __cv: CvRecorder; __cvBound?: boolean };
      w.__cv = { events: [], armRan: false };
      // Listeners are bound once; re-invoking only clears the log, so a test can
      // take a fresh reading between phases without double-recording.
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

/**
 * Wait until relevance transitions have both ARRIVED and STOPPED arriving.
 *
 * Condition-based rather than a fixed sleep, per the repo's zero-allowlist e2e
 * STOP rule. It is also the stronger check: requiring `count > since` means a
 * scroll that provoked nothing fails here instead of silently handing a later
 * absence-assertion a page where nothing ever happened.
 *
 * Several consecutive stable samples, not two. Relevance transitions arrive in
 * ragged waves as off-screen chunks refine their reserved size over successive
 * frames, so two equal readings are routinely a lull inside a burst rather than
 * its end. `scrollWysiwygBlockToTop` in `_helpers/landing.ts` reached the same
 * conclusion about the same phenomenon and holds for five stable frames; this
 * matches it. Under-waiting matters here more than it does there, because what
 * this gates is an ABSENCE assertion — settle too early and the target's lock
 * simply has not happened yet, which reads as the property holding.
 */
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
        // Fixed cadence, not `expect.poll`'s default exponential backoff. Under
        // the default, five stable samples cannot be reached before the sixth
        // attempt, which alone eats seconds of the budget and leaves real
        // settling headroom well under what `SETTLE_TIMEOUT_MS` implies. It
        // fails safe either way — a premature timeout is a false failure, never
        // a false pass — but a fixed interval makes the accepted quiescence
        // window a stated number rather than a side effect of the backoff curve.
        intervals: [SETTLE_POLL_INTERVAL_MS],
        message: 'cv:auto relevance transitions never arrived, or never stopped arriving',
      },
    )
    .toBeGreaterThanOrEqual(REQUIRED_STABLE_SAMPLES);
}

/** Isolated per-test tall doc: seed, navigate, wait for sync + editor mount. */
async function setupTallDoc(page: Page, api: ApiHelpers): Promise<void> {
  const docName = `test-cvauto-${randomUUID().slice(0, 8)}`;
  const { markdown } = generateTallDoc({ blockCount: BLOCK_COUNT });
  await api.seedDocs([{ name: docName, markdown }]);
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator(WYSIWYG).first()).toBeVisible();
}

/** Put the target at the readable top and confirm the scroll converged. */
async function stageTargetForClick(page: Page, marker: string): Promise<void> {
  const settleDelta = await scrollWysiwygBlockToTop(page, marker);
  expect(
    Math.abs(settleDelta),
    `setup scroll did not converge block "${marker}" to the readable top`,
  ).toBeLessThan(40);
}

/**
 * Scroll down by `viewports` viewport heights, then wait for the relevance
 * transitions that provokes to settle.
 *
 * Returns the distance the browser ACTUALLY applied. `scrollTop +=` is clamped
 * at the scroller's maximum, so a caller that reasons about distance has to
 * measure it: the phase asserting a clicked block never locks would otherwise
 * be silently weakened by a clamp while sibling-block transitions kept the run
 * looking healthy.
 */
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

/**
 * Press-and-release at (x, y), then classify whether the renderer survived.
 *
 * Raced against the page `crash` event because a dead renderer can leave the
 * in-flight input protocol call hanging (it would otherwise burn the whole test
 * budget before the assertion runs); either signal classifies as
 * `renderer-crashed` so the test fails on the assertion, not on infrastructure
 * noise. Mirrors the sibling `.ok-mode-hidden` pin's probe.
 */
async function pressAndProbe(page: Page, x: number, y: number): Promise<ClickOutcome> {
  // Registered and removed explicitly rather than via `once`, which only
  // detaches when the event FIRES. On the asserted path the renderer survives,
  // so a `once` listener would linger along with its never-settling promise,
  // and the churn arm calls this repeatedly against a single `Page`
  // (`CHURN_CLICK_COUNT`) — enough accumulation to spill listener warnings into
  // exactly the CI log someone would be reading if this pin ever went red.
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
      // Liveness probe: a crashed page rejects (or never answers) evaluate.
      await page.evaluate(() => document.readyState);
      return 'alive';
    })().catch((): ClickOutcome => 'renderer-crashed');
    return await Promise.race([crashed, clickAndProbe]);
  } finally {
    if (onCrash) page.off('crash', onCrash);
  }
}

/**
 * A point over the block's emphasised marker element, so the hit test resolves
 * to a DESCENDANT of the wrapper rather than the wrapper itself — the only
 * shape that can reach the CHECK. Throws on an empty box, because a click at a
 * guessed coordinate would miss the editor and pass for the wrong reason.
 */
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

  // Phase 1 (control) — scroll the target away WITHOUT clicking it. This proves
  // the display-lock machinery is live in this run and that the scroll distance
  // is enough to move this particular block out of the render margin. Without
  // it, phase 2's "did not lock" result would be indistinguishable from "never
  // could have locked".
  await stageTargetForClick(page, targetMarker);
  await trackLockTransitions(page);
  const controlDistance = await scrollAway(page, 2);
  const control = await readLockReport(page);
  expect(
    control.events.filter((e) => e.marker === targetMarker && e.skipped).length,
    `control failed: block "${targetMarker}" did not enter a cv:auto paint lock even unclicked, so this run cannot tell a selection pin from an inert page`,
  ).toBeGreaterThan(0);

  // Phase 2 — bring it back (which makes it relevant again), click it to place
  // the caret inside it, then scroll it FOUR TIMES the control distance away.
  await stageTargetForClick(page, targetMarker);
  await trackLockTransitions(page);
  const point = await pointInsideBlockText(page, targetMarker);
  const outcome = await pressAndProbe(page, point.x, point.y);
  expect(outcome, 'renderer must survive an ordinary click into a chunk wrapper').toBe('alive');
  const clickedDistance = await scrollAway(page, 8);

  // The distance claim is measured, not inferred from the seed geometry: a
  // clamped or short scroll would quietly turn "distance-independent" into
  // "barely moved". The bound has to be STRICTLY GREATER by a real margin, not
  // merely "at least as far" — a clamp down to exactly the control distance
  // would satisfy that weaker form while destroying the only thing this phase
  // establishes, and every other check here would still pass because sibling
  // blocks carry `skippedCount`.
  expect(
    clickedDistance,
    'the post-click scroll was clamped to near the control distance, so this phase no longer distinguishes a selection pin from simply not having travelled far enough',
  ).toBeGreaterThan(controlDistance * 2);

  const after = await readLockReport(page);
  // Sibling blocks must still be locking, or the page went inert and the
  // assertion below would pass for the wrong reason.
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

  // Arm: on the next mousedown (capture phase — after Blink's hit test has
  // resolved a descendant text node, before the default selection handling
  // reads a caret out of it), scroll the clicked block two viewports out of the
  // cv:auto render margin and force style+layout.
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
  // A `window` capture listener proves a press was DISPATCHED, not that it
  // landed on a descendant of the target wrapper — so this cannot say "the
  // click missed", only that no press reached the page at all.
  expect(report.armRan, 'no mousedown was dispatched to the page, so the arm never ran').toBe(true);
  // Aggregate-only on purpose, unlike test 1's target-specific check. The
  // clicked block CANNOT lock here — the click pins it relevant, which is the
  // property test 1 establishes — so a symmetric per-target assertion would be
  // asserting the opposite of a known result. What this arm needs is only that
  // the scroll drove SOME wrapper out of relevance, proving the machinery ran.
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

  // The field stack has the click dispatched as RAF-aligned input from inside
  // `BeginMainFrame` — Chromium coalesces input onto the frame boundary when
  // the main thread is congested, which is the one path where a rendering
  // update can occur inside an input dispatch. Script cannot select that path
  // directly, so this arm reproduces the condition that selects it: a busy main
  // thread plus continuous scrolling that keeps wrappers flipping in and out of
  // relevance while clicks land. It therefore does NOT prove the RAF-aligned
  // path was taken; it makes it likely and asserts the renderer survived.
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
      // Cancellable: without this the loop keeps burning ~12 of every ~16ms and
      // scrolling a viewport per frame through the post-loop reads, teardown,
      // and any failure-artifact capture — which is both wasted CI time and a
      // page still moving underneath whatever a red run tries to screenshot.
      w.__churnStop = () => {
        running = false;
      };
      const step = (): void => {
        if (!running) return;
        // Overrun a 60Hz frame budget without stalling the run, so Chromium
        // starts coalescing input onto the frame boundary.
        const until = performance.now() + 12;
        while (performance.now() < until) {
          /* deliberate main-thread burn */
        }
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
  // Survival is asserted FIRST, before anything else touches the page. The
  // loop exits early on a crash, so any `page.evaluate` placed above this
  // would be the first call against a dead renderer: it would reject, and the
  // test would fail on "Target crashed" instead of on the message below, which
  // names the property and the site that failed. That is exactly what
  // `pressAndProbe` races the `crash` event to avoid, and it would be undone
  // on the single path this whole file exists to detect.
  expect(
    outcome,
    'renderer must survive clicks landing while .ok-chunk-wrapper blocks flip cv:auto relevance under a congested main thread',
  ).toBe('alive');

  // Now that the renderer is known alive, stop the churn so the reads below
  // measure a settled page and nothing keeps scrolling during teardown.
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
