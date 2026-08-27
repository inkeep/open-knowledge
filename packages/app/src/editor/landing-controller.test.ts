// @vitest-environment jsdom
/**
 * Coverage for the landing controller: the centered-scroll math and the settle
 * contract (immediate dispatch, event-driven re-dispatch on drift, user-scroll
 * cancel, mode-flip cancel with queue discard, the bounded abandon, and the
 * precedence between a landing and an explicit navigation arriving mid-settle).
 * The controller drives real DOM (scroll writes, event listeners, ResizeObserver)
 * so this file opts into jsdom via the docblock above; it is not a React mount
 * test, so it stays `.test.ts`.
 *
 * Real geometry (`getBoundingClientRect`, layout, `content-visibility`) does not
 * exist in jsdom, so `clientHeight`/`scrollHeight`/`scrollTop` are defined on the
 * container as plain properties and the target geometry is injected through
 * `measureTarget` — the same seam production callers use. `requestAnimationFrame`
 * is stubbed to a no-op so the settle is driven deterministically by the injected
 * signals and the fake timers, never by a real frame callback.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getCollector } from '../lib/perf/collector';
import {
  centeredScrollTop,
  type LandingCancelReason,
  type LandingHandle,
  type LandingOutcome,
  type LandingPlacement,
  type StartLandingParams,
  startLanding,
  type TargetMetrics,
} from './landing-controller';
import {
  __resetScrollRestoreCoordination,
  getDocScrollState,
  isScrollRestoreSuppressed,
  runScrollNavigation,
} from './scroll-restore-coordination';

const TOOLBAR = 56;
const VIEWPORT = 800;

function buildScroller(scrollHeight = 6000): { container: HTMLElement; content: HTMLElement } {
  const container = document.createElement('div');
  const content = document.createElement('div');
  container.appendChild(content);
  Object.defineProperty(container, 'clientHeight', { value: VIEWPORT, configurable: true });
  Object.defineProperty(container, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true });
  container.style.overflowAnchor = 'auto';
  document.body.appendChild(container);
  return { container, content };
}

// jsdom's CSS engine may not persist `overflow-anchor`; only assert its value
// where the environment actually round-trips the property.
const OVERFLOW_ANCHOR_SUPPORTED = (() => {
  const probe = document.createElement('div');
  probe.style.overflowAnchor = 'none';
  return probe.style.overflowAnchor === 'none';
})();

type StartOverrides = Partial<StartLandingParams> &
  Pick<StartLandingParams, 'container' | 'measureTarget'>;

function startLandingWith(overrides: StartOverrides): LandingHandle {
  const placement: LandingPlacement = overrides.placement ?? 'center';
  const params: StartLandingParams = {
    docName: 'doc',
    grade: 'exact',
    placement,
    intent: 'toggle',
    landedMode: 'source',
    toolbarOffset: TOOLBAR,
    ...overrides,
  };
  return startLanding(params);
}

function markNamed(name: string): { properties?: Record<string, unknown> } | undefined {
  return getCollector()
    ?.marks.toArray()
    .find((m) => m.name === name);
}

beforeEach(() => {
  vi.useFakeTimers();
  // The frame callback is an accelerator, not a terminal signal; removing it
  // makes the settle deterministic under fake timers + injected events.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  getCollector()?.reset();
  __resetScrollRestoreCoordination();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('centeredScrollTop', () => {
  test('lands the target center at the center of the region below the toolbar', () => {
    const m: TargetMetrics = { top: 1000, height: 100 };
    const scrollTop = centeredScrollTop(m, VIEWPORT, TOOLBAR);
    expect(scrollTop).toBe(622); // 1000 + 50 - (56 + 800) / 2

    const targetCenterOnScreen = m.top + m.height / 2 - scrollTop;
    expect(targetCenterOnScreen).toBe((TOOLBAR + VIEWPORT) / 2); // 428, center of [56, 800]
  });

  test('the toolbar offset biases the landing down by half the toolbar height', () => {
    const m: TargetMetrics = { top: 1000, height: 100 };
    expect(centeredScrollTop(m, VIEWPORT, TOOLBAR)).toBe(
      centeredScrollTop(m, VIEWPORT, 0) - TOOLBAR / 2,
    );
  });
});

describe('startLanding — dispatch and settle', () => {
  test('dispatches the centered target immediately, then lands and releases its holds', () => {
    const { container } = buildScroller();
    const outcomes: LandingOutcome[] = [];
    startLandingWith({
      container,
      measureTarget: () => ({ top: 2000, height: 60 }),
      onOutcome: (o) => outcomes.push(o),
    });

    const expected = centeredScrollTop({ top: 2000, height: 60 }, VIEWPORT, TOOLBAR);
    expect(container.scrollTop).toBe(expected); // synchronous dispatch
    expect(isScrollRestoreSuppressed('doc')).toBe(true); // held for the window
    if (OVERFLOW_ANCHOR_SUPPORTED) expect(container.style.overflowAnchor).toBe('none');

    vi.advanceTimersByTime(150); // trailing quiet elapses → land

    expect(outcomes).toEqual([{ status: 'landed', delta: 0 }]);
    const landMark = markNamed('ok/landing/land');
    expect(landMark?.properties?.grade).toBe('exact');
    expect(landMark?.properties?.delta).toBe(0);
    expect(isScrollRestoreSuppressed('doc')).toBe(false); // released on land
    if (OVERFLOW_ANCHOR_SUPPORTED) expect(container.style.overflowAnchor).toBe('auto');
  });

  test('persists the landing so a later scroll restore reproduces it', () => {
    const { container } = buildScroller();
    expect(getDocScrollState('doc')).toBeUndefined(); // nothing persisted yet
    startLandingWith({
      container,
      measureTarget: () => ({ top: 2000, height: 60 }),
      landedMode: 'wysiwyg',
    });
    const expected = centeredScrollTop({ top: 2000, height: 60 }, VIEWPORT, TOOLBAR);
    vi.advanceTimersByTime(150); // land

    // The landing is persisted body-relative; with no above-body anchor in this
    // container the stored offset is the raw target, so a later restore lands
    // back on it instead of the pre-landing position. The landed mode is stamped
    // so a later re-activation in the other mode floors instead of driving it.
    expect(getDocScrollState('doc')?.offset).toBe(expected);
    expect(getDocScrollState('doc')?.mode).toBe('wysiwyg');
  });

  test('holds the queued target while the editor is still mounting, then lands it', () => {
    const { container } = buildScroller();
    let metrics: TargetMetrics | null = null; // not yet measurable
    startLandingWith({ container, measureTarget: () => metrics });

    expect(container.scrollTop).toBe(0); // nothing to dispatch yet
    expect(isScrollRestoreSuppressed('doc')).toBe(true); // window open, target retained

    metrics = { top: 3000, height: 50 }; // editor laid out
    container.dispatchEvent(new Event('contentvisibilityautostatechange'));

    expect(container.scrollTop).toBe(centeredScrollTop(metrics, VIEWPORT, TOOLBAR));
  });

  test('re-dispatches when the target drifts beyond the threshold', () => {
    const { container } = buildScroller();
    let top = 1000;
    startLandingWith({ container, measureTarget: () => ({ top, height: 40 }), grade: 'ordinal' });

    const first = centeredScrollTop({ top: 1000, height: 40 }, VIEWPORT, TOOLBAR);
    expect(container.scrollTop).toBe(first);

    top = 500; // blocks above materialize; the target moves up
    container.dispatchEvent(new Event('contentvisibilityautostatechange'));

    const second = centeredScrollTop({ top: 500, height: 40 }, VIEWPORT, TOOLBAR);
    expect(second).not.toBe(first); // the target genuinely moved
    expect(container.scrollTop).toBe(second); // and the view followed it
  });

  test('re-dispatches on a content-column resize', () => {
    let fire: (() => void) | undefined;
    class FakeResizeObserver {
      constructor(cb: () => void) {
        fire = cb;
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    const { container, content } = buildScroller();
    let top = 1000;
    const handle = startLandingWith({
      container,
      contentColumn: content,
      measureTarget: () => ({ top, height: 40 }),
    });
    const first = container.scrollTop;

    top = 1400;
    fire?.(); // the content column grew

    const second = centeredScrollTop({ top: 1400, height: 40 }, VIEWPORT, TOOLBAR);
    expect(second).not.toBe(first);
    expect(container.scrollTop).toBe(second);
    handle.cancel('mode-flip');
  });

  test("'top' placement pins the block top just below the toolbar", () => {
    const { container } = buildScroller();
    startLandingWith({
      container,
      measureTarget: () => ({ top: 1000, height: 40 }),
      placement: 'top',
    });
    expect(container.scrollTop).toBe(1000 - TOOLBAR);
  });

  test('emits a mode-switch transition mark when a transition is provided', () => {
    const { container } = buildScroller();
    startLandingWith({
      container,
      measureTarget: () => ({ top: 1000, height: 40 }),
      placement: 'top',
      transition: { from: 'wysiwyg', to: 'source' },
    });
    const transitionMark = markNamed('ok/mode-switch/transition');
    expect(transitionMark?.properties?.from).toBe('wysiwyg');
    expect(transitionMark?.properties?.to).toBe('source');
  });
});

describe('startLanding — cancel and abandon', () => {
  test('cancels on the user wheel and does not re-dispatch afterward', () => {
    const { container } = buildScroller();
    let top = 1000;
    const outcomes: LandingOutcome[] = [];
    const discard = vi.fn();
    startLandingWith({
      container,
      measureTarget: () => ({ top, height: 40 }),
      onOutcome: (o) => outcomes.push(o),
      onDiscardQueuedTarget: discard,
    });
    const afterDispatch = container.scrollTop;

    container.dispatchEvent(new Event('wheel'));

    expect(outcomes).toEqual([{ status: 'cancelled', reason: 'user-scroll' }]);
    expect(isScrollRestoreSuppressed('doc')).toBe(false); // released
    expect(discard).not.toHaveBeenCalled(); // user-scroll keeps the queue (already consumed)

    // A late layout signal must not drag the view back onto the target.
    top = 200;
    container.dispatchEvent(new Event('contentvisibilityautostatechange'));
    expect(container.scrollTop).toBe(afterDispatch);
  });

  test('cancels on a touch gesture', () => {
    const { container } = buildScroller();
    const outcomes: LandingOutcome[] = [];
    startLandingWith({
      container,
      measureTarget: () => ({ top: 1000, height: 40 }),
      onOutcome: (o) => outcomes.push(o),
    });
    container.dispatchEvent(new Event('touchstart'));
    expect(outcomes).toEqual([{ status: 'cancelled', reason: 'user-scroll' }]);
  });

  test('cancels on a mode flip and discards the queued target', () => {
    const { container } = buildScroller();
    const outcomes: LandingOutcome[] = [];
    const discard = vi.fn();
    const handle = startLandingWith({
      container,
      measureTarget: () => ({ top: 1000, height: 40 }),
      onOutcome: (o) => outcomes.push(o),
      onDiscardQueuedTarget: discard,
    });

    const reason: LandingCancelReason = 'mode-flip';
    handle.cancel(reason);

    expect(outcomes).toEqual([{ status: 'cancelled', reason: 'mode-flip' }]);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('abandons after the window when the target never settles, marking target and delta', () => {
    const { container } = buildScroller();
    let top = 1000;
    const outcomes: LandingOutcome[] = [];
    startLandingWith({
      container,
      measureTarget: () => ({ top, height: 40 }),
      onOutcome: (o) => outcomes.push(o),
    });

    // Perpetual layout churn: every 100ms the target oscillates between two
    // in-range positions and a signal fires, so each step drifts past the
    // threshold, the settle countdown is always reset, and it never elapses
    // before the 2s cap. Oscillating (not growing) keeps both targets off the
    // clamp ceiling, where a pinned target would stop drifting and settle.
    for (let elapsed = 0; elapsed < 2000; elapsed += 100) {
      top = top === 1000 ? 2500 : 1000;
      container.dispatchEvent(new Event('contentvisibilityautostatechange'));
      vi.advanceTimersByTime(100);
    }

    expect(outcomes.some((o) => o.status === 'abandoned')).toBe(true);
    expect(outcomes.some((o) => o.status === 'landed')).toBe(false);
    const abandonMark = markNamed('ok/landing/abandoned');
    expect(typeof abandonMark?.properties?.target).toBe('number');
    expect(typeof abandonMark?.properties?.delta).toBe('number');
    expect(isScrollRestoreSuppressed('doc')).toBe(false); // released on abandon
  });

  test('terminates exactly once — a cancel after landing is a no-op', () => {
    const { container } = buildScroller();
    const outcomes: LandingOutcome[] = [];
    const handle = startLandingWith({
      container,
      measureTarget: () => ({ top: 1000, height: 40 }),
      onOutcome: (o) => outcomes.push(o),
    });
    vi.advanceTimersByTime(150); // land
    handle.cancel('mode-flip'); // must not add a second outcome or re-discard

    expect(outcomes).toEqual([{ status: 'landed', delta: 0 }]);
  });

  test('abandons (not lands) when the target is never measurable', () => {
    const { container } = buildScroller();
    const outcomes: LandingOutcome[] = [];
    startLandingWith({
      container,
      measureTarget: () => null, // editor never lays out
      onOutcome: (o) => outcomes.push(o),
    });
    expect(container.scrollTop).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(outcomes).toEqual([{ status: 'abandoned', delta: 0 }]);
  });
});

/**
 * An explicit navigation — a Problems-panel or outline row, a find/replace
 * match, a deep link — landing inside an open settle window. The scroll below
 * stands in for whichever applier ran it; what is under test is who owns the
 * scroller afterward.
 */
describe('startLanding — explicit navigation pre-emption', () => {
  const NAV_SCROLL_TOP = 1189;

  test('supersedes a toggle landing, and the navigation keeps the scroller', () => {
    const { container } = buildScroller();
    const outcomes: LandingOutcome[] = [];
    const discard = vi.fn();
    let top = 2000;
    startLandingWith({
      container,
      measureTarget: () => ({ top, height: 60 }),
      placement: 'top',
      intent: 'toggle',
      onOutcome: (o) => outcomes.push(o),
      onDiscardQueuedTarget: discard,
    });
    expect(container.scrollTop).toBe(2000 - TOOLBAR);

    const ran = runScrollNavigation('doc', 'outline', () => {
      container.scrollTop = NAV_SCROLL_TOP;
    });

    expect(ran).toBe(true);
    expect(container.scrollTop).toBe(NAV_SCROLL_TOP);
    expect(outcomes).toEqual([{ status: 'cancelled', reason: 'superseded' }]);
    // The superseded landing let go of the flag as it unwound; the only hold
    // left is the navigation's own. Ref-counting is what makes this pair a leak
    // check: a landing handle that survived its supersede would keep the count
    // above zero even after the navigation released.
    expect(isScrollRestoreSuppressed('doc')).toBe(true);
    // The queued intent was already consumed to start this landing, so there is
    // nothing stale left to replay — same as a user-scroll cancel.
    expect(discard).not.toHaveBeenCalled();

    // The settle loop is closed: neither a late layout signal nor the elapsed
    // quiet window may pull the view back onto the landing's target.
    top = 400;
    container.dispatchEvent(new Event('contentvisibilityautostatechange'));
    vi.advanceTimersByTime(2000);
    expect(container.scrollTop).toBe(NAV_SCROLL_TOP);
    expect(outcomes).toHaveLength(1);
    expect(isScrollRestoreSuppressed('doc')).toBe(false); // and neither hold leaked
  });

  test('does not persist the position it would have erased', () => {
    const { container } = buildScroller();
    startLandingWith({
      container,
      measureTarget: () => ({ top: 2000, height: 60 }),
      placement: 'top',
      intent: 'toggle',
    });

    runScrollNavigation('doc', 'outline', () => {
      container.scrollTop = NAV_SCROLL_TOP;
    });
    vi.advanceTimersByTime(2000);

    // Landing on a superseded target would write it into the doc scroll state
    // and reproduce the erasure on every later restore. A superseded landing
    // never lands, so it records nothing; the navigation's own position is
    // captured by the container's scroll listener instead.
    expect(getDocScrollState('doc')).toBeUndefined();
  });

  test('a jump landing keeps the scroller and the navigation stands down', () => {
    const { container } = buildScroller();
    const outcomes: LandingOutcome[] = [];
    const scroll = vi.fn();
    startLandingWith({
      container,
      measureTarget: () => ({ top: 2000, height: 60 }),
      placement: 'center',
      intent: 'jump',
      onOutcome: (o) => outcomes.push(o),
    });
    const landingTarget = container.scrollTop;

    const ran = runScrollNavigation('doc', 'outline', scroll);

    // A jump has already placed the caret, so pre-empting it would split caret
    // from viewport — the failure this contract exists to prevent.
    expect(ran).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(landingTarget);
    expect(outcomes).toEqual([]); // still open

    vi.advanceTimersByTime(150);
    expect(outcomes).toEqual([{ status: 'landed', delta: 0 }]);
  });

  test('a navigation on another document leaves the landing alone', () => {
    const { container } = buildScroller();
    const outcomes: LandingOutcome[] = [];
    startLandingWith({
      container,
      measureTarget: () => ({ top: 2000, height: 60 }),
      placement: 'top',
      intent: 'toggle',
      onOutcome: (o) => outcomes.push(o),
    });

    expect(runScrollNavigation('some-other-doc', 'outline', () => {})).toBe(true);

    expect(outcomes).toEqual([]);
    vi.advanceTimersByTime(150);
    expect(outcomes).toEqual([{ status: 'landed', delta: 0 }]);
  });

  test('a landing that already terminated no longer holds the scroller', () => {
    const { container } = buildScroller();
    startLandingWith({
      container,
      measureTarget: () => ({ top: 2000, height: 60 }),
      placement: 'center',
      intent: 'jump',
    });
    vi.advanceTimersByTime(150); // land

    const scroll = vi.fn();
    expect(runScrollNavigation('doc', 'outline', scroll)).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(1);
  });
});

/**
 * `measureTarget` is injected, and the production measurers read a live editor
 * view — which can be torn down mid-settle, and then throws rather than
 * answering. Neither hold the controller takes decays on its own: a stranded
 * suppression disables scroll restore for the document for the rest of the
 * session, and a stranded `jump` owner (which does not yield) makes every later
 * outline click, Problems row, find match and deep link for it silently no-op.
 * So every exit — including the throwing ones, and including a start that never
 * returns a handle to cancel — has to release both. A `jump` landing is used
 * throughout: it is the shape whose leak `runScrollNavigation` can observe.
 */
describe('startLanding — a throwing measurer releases every hold', () => {
  const BOOM = 'view destroyed mid-settle';

  /** Both holds are gone and an explicit navigation can take the scroller. */
  function expectHoldsReleased(): void {
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
    const scroll = vi.fn();
    expect(runScrollNavigation('doc', 'outline', scroll)).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(1);
  }

  test('when the first dispatch throws, before any handle is returned', () => {
    const { container } = buildScroller();

    expect(() =>
      startLandingWith({
        container,
        measureTarget: () => {
          throw new Error(BOOM);
        },
        placement: 'center',
        intent: 'jump',
      }),
    ).toThrow(BOOM);

    expectHoldsReleased();
  });

  test('when the measurer starts throwing before the settle lands', () => {
    const { container } = buildScroller();
    const outcomes: LandingOutcome[] = [];
    let throwing = false;
    startLandingWith({
      container,
      measureTarget: (): TargetMetrics | null => {
        if (throwing) throw new Error(BOOM);
        return { top: 2000, height: 60 };
      },
      placement: 'center',
      intent: 'jump',
      onOutcome: (o) => outcomes.push(o),
    });

    throwing = true; // the view goes away while the quiet window is running
    expect(() => vi.advanceTimersByTime(150)).toThrow(BOOM);

    expectHoldsReleased();
    expect(outcomes).toEqual([]); // a throw is not reported as a landing
  });

  test('when the measurer throws at the abandon deadline', () => {
    const { container } = buildScroller();
    const outcomes: LandingOutcome[] = [];
    let throwing = false;
    startLandingWith({
      container,
      // Never measurable, so nothing arms the quiet timer and the abandon
      // deadline is the terminal path this lands on.
      measureTarget: (): TargetMetrics | null => {
        if (throwing) throw new Error(BOOM);
        return null;
      },
      placement: 'center',
      intent: 'jump',
      onOutcome: (o) => outcomes.push(o),
    });

    throwing = true;
    expect(() => vi.advanceTimersByTime(2000)).toThrow(BOOM);

    expectHoldsReleased();
    expect(outcomes).toEqual([]);
  });
});
