// @vitest-environment jsdom

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
    expect(scrollTop).toBe(622);

    const targetCenterOnScreen = m.top + m.height / 2 - scrollTop;
    expect(targetCenterOnScreen).toBe((TOOLBAR + VIEWPORT) / 2);
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
    expect(container.scrollTop).toBe(expected);
    expect(isScrollRestoreSuppressed('doc')).toBe(true);
    if (OVERFLOW_ANCHOR_SUPPORTED) expect(container.style.overflowAnchor).toBe('none');

    vi.advanceTimersByTime(150);

    expect(outcomes).toEqual([{ status: 'landed', delta: 0 }]);
    const landMark = markNamed('ok/landing/land');
    expect(landMark?.properties?.grade).toBe('exact');
    expect(landMark?.properties?.delta).toBe(0);
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
    if (OVERFLOW_ANCHOR_SUPPORTED) expect(container.style.overflowAnchor).toBe('auto');
  });

  test('persists the landing so a later scroll restore reproduces it', () => {
    const { container } = buildScroller();
    expect(getDocScrollState('doc')).toBeUndefined();
    startLandingWith({
      container,
      measureTarget: () => ({ top: 2000, height: 60 }),
      landedMode: 'wysiwyg',
    });
    const expected = centeredScrollTop({ top: 2000, height: 60 }, VIEWPORT, TOOLBAR);
    vi.advanceTimersByTime(150);

    expect(getDocScrollState('doc')?.offset).toBe(expected);
    expect(getDocScrollState('doc')?.mode).toBe('wysiwyg');
  });

  test('holds the queued target while the editor is still mounting, then lands it', () => {
    const { container } = buildScroller();
    let metrics: TargetMetrics | null = null;
    startLandingWith({ container, measureTarget: () => metrics });

    expect(container.scrollTop).toBe(0);
    expect(isScrollRestoreSuppressed('doc')).toBe(true);

    metrics = { top: 3000, height: 50 };
    container.dispatchEvent(new Event('contentvisibilityautostatechange'));

    expect(container.scrollTop).toBe(centeredScrollTop(metrics, VIEWPORT, TOOLBAR));
  });

  test('re-dispatches when the target drifts beyond the threshold', () => {
    const { container } = buildScroller();
    let top = 1000;
    startLandingWith({ container, measureTarget: () => ({ top, height: 40 }), grade: 'ordinal' });

    const first = centeredScrollTop({ top: 1000, height: 40 }, VIEWPORT, TOOLBAR);
    expect(container.scrollTop).toBe(first);

    top = 500;
    container.dispatchEvent(new Event('contentvisibilityautostatechange'));

    const second = centeredScrollTop({ top: 500, height: 40 }, VIEWPORT, TOOLBAR);
    expect(second).not.toBe(first);
    expect(container.scrollTop).toBe(second);
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
    fire?.();

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
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
    expect(discard).not.toHaveBeenCalled();

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
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('terminates exactly once — a cancel after landing is a no-op', () => {
    const { container } = buildScroller();
    const outcomes: LandingOutcome[] = [];
    const handle = startLandingWith({
      container,
      measureTarget: () => ({ top: 1000, height: 40 }),
      onOutcome: (o) => outcomes.push(o),
    });
    vi.advanceTimersByTime(150);
    handle.cancel('mode-flip');

    expect(outcomes).toEqual([{ status: 'landed', delta: 0 }]);
  });

  test('abandons (not lands) when the target is never measurable', () => {
    const { container } = buildScroller();
    const outcomes: LandingOutcome[] = [];
    startLandingWith({
      container,
      measureTarget: () => null,
      onOutcome: (o) => outcomes.push(o),
    });
    expect(container.scrollTop).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(outcomes).toEqual([{ status: 'abandoned', delta: 0 }]);
  });
});

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
    expect(isScrollRestoreSuppressed('doc')).toBe(true);
    expect(discard).not.toHaveBeenCalled();

    top = 400;
    container.dispatchEvent(new Event('contentvisibilityautostatechange'));
    vi.advanceTimersByTime(2000);
    expect(container.scrollTop).toBe(NAV_SCROLL_TOP);
    expect(outcomes).toHaveLength(1);
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
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

    expect(ran).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(landingTarget);
    expect(outcomes).toEqual([]);

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
    vi.advanceTimersByTime(150);

    const scroll = vi.fn();
    expect(runScrollNavigation('doc', 'outline', scroll)).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(1);
  });
});

describe('startLanding — a throwing measurer releases every hold', () => {
  const BOOM = 'view destroyed mid-settle';

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

    throwing = true;
    expect(() => vi.advanceTimersByTime(150)).toThrow(BOOM);

    expectHoldsReleased();
    expect(outcomes).toEqual([]);
  });

  test('when the measurer throws at the abandon deadline', () => {
    const { container } = buildScroller();
    const outcomes: LandingOutcome[] = [];
    let throwing = false;
    startLandingWith({
      container,
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
