// @vitest-environment jsdom
/**
 * Wiring coverage for the real `ScrollPreservingContainer` restore paths:
 *   - the scroll-restore suppression seam: it must consult the coordination
 *     registry and stand down (write no scrollTop) while a landing holds a
 *     suppression handle, so a landing can be the single scroll writer;
 *   - the cross-mode re-activation floor: when the saved position was captured
 *     in a different mode than the one being re-activated, the container must
 *     land proportionally in a single write (not drive the other mode's offset)
 *     and emit a diagnostic mark — including when the restore cannot be applied.
 *
 * jsdom computes no layout, so scroll geometry is stubbed on the prototype:
 * `scrollHeight`/`clientHeight` read from mutable stand-ins (so a test can make
 * the content non-overflowing) and `scrollTop` is a settable backing store (the
 * observable the restore writes). The restore's Stage-1 / cross-mode write runs
 * synchronously inside the layout effect, so the assertions read it immediately
 * after mount without awaiting the rAF poll.
 */

import { cleanup, render } from '@testing-library/react';
import type { RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __resetScrollRestoreCoordination,
  acquireScrollRestoreSuppression,
  rememberDocScrollState,
} from '@/editor/scroll-restore-coordination';
import type { EditorModeValue } from '@/editor/use-editor-mode';
import { getCollector } from '@/lib/perf/collector';
import { ScrollPreservingContainer } from './EditorActivityPool';
import { RESTORE_BACKSTOP_MS } from './scroll-restore';

const scrollTops = new WeakMap<HTMLElement, number>();
let stubScrollHeight = 5000;
let stubClientHeight = 0;
let origScrollTop: PropertyDescriptor | undefined;
let origScrollHeight: PropertyDescriptor | undefined;
let origClientHeight: PropertyDescriptor | undefined;

function restoreDescriptor(
  prop: 'scrollTop' | 'scrollHeight' | 'clientHeight',
  desc: PropertyDescriptor | undefined,
) {
  if (desc) Object.defineProperty(HTMLElement.prototype, prop, desc);
  else Reflect.deleteProperty(HTMLElement.prototype, prop);
}

beforeEach(() => {
  __resetScrollRestoreCoordination();
  getCollector()?.reset();
  stubScrollHeight = 5000;
  stubClientHeight = 0;
  origScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
  origScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      // Clamped like a real scroller rather than accepting any number: a
      // browser refuses a scrollTop outside [0, scrollHeight - clientHeight],
      // so a restore aiming past the rendered runway comes to rest SHORT of
      // its target. An unclamped stub makes every write land, which is the one
      // behaviour that would hide the failures these marks exist to report.
      const maxScroll = Math.max(0, stubScrollHeight - stubClientHeight);
      scrollTops.set(this, Math.min(Math.max(0, value), maxScroll));
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return stubScrollHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return stubClientHeight;
    },
  });
});

afterEach(() => {
  cleanup();
  __resetScrollRestoreCoordination();
  restoreDescriptor('scrollTop', origScrollTop);
  restoreDescriptor('scrollHeight', origScrollHeight);
  restoreDescriptor('clientHeight', origClientHeight);
});

function scrollerOf(container: HTMLElement): HTMLDivElement {
  const el = container.querySelector<HTMLDivElement>('[data-testid="editor-scroll-container"]');
  if (!el) throw new Error('editor-scroll-container not rendered');
  return el;
}

/**
 * Re-apply the scroller's current offset so the stub clamps it against the
 * height that just changed — what a browser does on its own the moment content
 * shrinks under a scrolled viewport.
 */
function reclampToCurrentHeight(el: HTMLElement) {
  const current = el.scrollTop;
  el.scrollTop = current;
}

function crossModeMark(): { properties?: Record<string, unknown> } | undefined {
  return getCollector()
    ?.marks.toArray()
    .find((m) => m.name === 'ok/scroll-restore/cross-mode');
}

/**
 * The diagnostic breadcrumbs a `console.info` spy captured, in emission order.
 * Both log transports agree on one wire shape — a lone `console.info` whose
 * only argument is `JSON.stringify({ event, ...props })` — so parsing the
 * argument back is what a bundle reader would see, non-JSON noise dropped.
 */
function breadcrumbLines(info: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return info.mock.calls.flatMap(([first]) => {
    if (typeof first !== 'string') return [];
    try {
      return [JSON.parse(first) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

function Harness({
  active,
  docName,
  mode = 'wysiwyg',
  initialScrollTop = 500,
  anchorRef,
}: {
  active: boolean;
  docName: string;
  mode?: EditorModeValue;
  initialScrollTop?: number;
  /** Optional body-top anchor. Omitted, the restore sees no anchor at all and
   *  falls back to the raw saved scrollTop. */
  anchorRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <ScrollPreservingContainer
      isActive={active}
      docName={docName}
      mode={mode}
      initialScrollTop={initialScrollTop}
      bodyAnchorRef={anchorRef}
    >
      <div>body content</div>
    </ScrollPreservingContainer>
  );
}

describe('ScrollPreservingContainer scroll-restore suppression', () => {
  test('restores scroll position when no landing is active', () => {
    const { container } = render(<Harness active docName="doc-a" />);
    expect(scrollerOf(container).scrollTop).toBe(500);
  });

  test('the ordinary restore reports the document and the geometry, not just a target', () => {
    // The whole point of routing these marks: a bundle without `docName` cannot
    // attribute the numbers, and one without the geometry cannot separate a
    // landing past real content from content that had not painted. Both were
    // absent from this mark before, which is why three scroll tickets shipped
    // with no scroll number on disk.
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      render(<Harness active docName="doc-geo" />);
      const lines = breadcrumbLines(info);
      // Matched exactly, not by containment: the risk this guards is a field
      // being DROPPED from the payload, which any objectContaining would wave
      // through. `contentBottom` is absent here because jsdom lays nothing out,
      // so the extent probe finds none — its presence on a real restore is what
      // the assertion's exactness protects for the day layout exists.
      expect(lines).toEqual([
        {
          event: 'ok/scroll-restore/phase1-success',
          docName: 'doc-geo',
          target: 500,
          elapsedMs: expect.any(Number),
          scrollTop: 500,
          scrollHeight: 5000,
          clientHeight: 0,
        },
      ]);
    } finally {
      info.mockRestore();
    }
  });

  test('stands down and writes no scroll position while a landing holds suppression', () => {
    acquireScrollRestoreSuppression('doc-b', 'landing');
    const { container } = render(<Harness active docName="doc-b" />);
    expect(scrollerOf(container).scrollTop).toBe(0);
  });

  test('resumes restoring on the next activation after the landing releases', () => {
    const handle = acquireScrollRestoreSuppression('doc-c', 'landing');
    const { container, rerender } = render(<Harness active={false} docName="doc-c" />);
    // Activate while suppressed → the restore stands down.
    rerender(<Harness active docName="doc-c" />);
    expect(scrollerOf(container).scrollTop).toBe(0);
    // Release, then re-activate → a fresh restore drives the saved position.
    handle.release();
    rerender(<Harness active={false} docName="doc-c" />);
    rerender(<Harness active docName="doc-c" />);
    expect(scrollerOf(container).scrollTop).toBe(500);
  });
});

describe('ScrollPreservingContainer cross-mode re-activation floor', () => {
  test('lands proportionally instead of driving the other mode saved offset', () => {
    // Saved in source at 40% through the doc; re-activated in wysiwyg. The
    // precise offset would drive the wysiwyg scroller against source geometry;
    // the floor lands proportionally: 0.4 * (5000 - 0) = 2000.
    rememberDocScrollState('doc-x', { offset: 4321, mode: 'source', fraction: 0.4 });
    const { container } = render(
      <Harness active docName="doc-x" mode="wysiwyg" initialScrollTop={0} />,
    );
    expect(scrollerOf(container).scrollTop).toBe(2000);
  });

  test('emits a diagnostic mark carrying both modes and the applied result', () => {
    rememberDocScrollState('doc-x', { offset: 4321, mode: 'source', fraction: 0.4 });
    render(<Harness active docName="doc-x" mode="wysiwyg" initialScrollTop={0} />);
    const m = crossModeMark();
    expect(m?.properties?.savedMode).toBe('source');
    expect(m?.properties?.mode).toBe('wysiwyg');
    expect(m?.properties?.target).toBe(2000);
    expect(m?.properties?.applied).toBe(true);
  });

  test('the same mark reaches the renderer log, where a bundle can carry it', () => {
    // The end of the route, exercised through the real restore rather than
    // through `mark()` directly: the collector this mark also lands in is
    // compiled out of production and `performance.measure` needs DevTools
    // attached, so the log line is the only one of the three a user can send us.
    // Three scroll tickets shipped without a single scroll number on disk.
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      rememberDocScrollState('doc-x', { offset: 4321, mode: 'source', fraction: 0.4 });
      render(<Harness active docName="doc-x" mode="wysiwyg" initialScrollTop={0} />);
      const lines = breadcrumbLines(info);
      expect(lines).toEqual([
        // `docName` correlates the numbers to a document, and the geometry
        // triple is what separates "landed past the content" from "content had
        // not painted yet" — the question that previously took an instrumented
        // reproduction to answer. Matched exactly so a dropped field fails.
        {
          event: 'ok/scroll-restore/cross-mode',
          docName: 'doc-x',
          savedMode: 'source',
          mode: 'wysiwyg',
          fraction: 0.4,
          target: 2000,
          applied: true,
          scrollTop: 2000,
          scrollHeight: 5000,
          clientHeight: 0,
        },
      ]);
    } finally {
      info.mockRestore();
    }
  });

  test('a same-mode re-activation is unaffected — no floor, no cross-mode mark', () => {
    // Same mode → the cross-mode branch is skipped and the normal restore drives
    // the saved position (raw target 777, since this harness renders no body
    // anchor), never the 0.4 proportional floor, and no cross-mode mark fires.
    rememberDocScrollState('doc-y', { offset: 4321, mode: 'wysiwyg', fraction: 0.4 });
    const { container } = render(
      <Harness active docName="doc-y" mode="wysiwyg" initialScrollTop={777} />,
    );
    expect(scrollerOf(container).scrollTop).toBe(777);
    expect(crossModeMark()).toBeUndefined();
  });

  test('marks applied:false when the new mode content cannot be scrolled', () => {
    // The new mode has no scrollable range (content fits the viewport), so the
    // floor cannot apply — but it must still emit the mark instead of failing
    // silently, which the old height-gated abandoned mark did not.
    stubScrollHeight = 400;
    stubClientHeight = 800;
    rememberDocScrollState('doc-z', { offset: 4321, mode: 'source', fraction: 0.4 });
    const { container } = render(
      <Harness active docName="doc-z" mode="wysiwyg" initialScrollTop={0} />,
    );
    expect(scrollerOf(container).scrollTop).toBe(0);
    expect(crossModeMark()?.properties?.applied).toBe(false);
  });
});

/**
 * The three `yielded` reasons and the `abandoned` backstop only fire on a
 * restore that is still in flight when something else claims the scroll, so
 * they need the rAF poll to actually run — faked here and driven a frame at a
 * time, rather than left to jsdom's real clock where the test would end first.
 */
describe('ScrollPreservingContainer restore-outcome marks', () => {
  /** One faked animation frame, plus margin: the fake clock schedules the
   *  callback on the next 16ms boundary rather than exactly 16ms out. */
  const ONE_FRAME_MS = 20;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'],
    });
  });

  afterEach(() => {
    // Unmount under the fake clock so the loop's teardown runs against the same
    // timer implementation that scheduled it.
    cleanup();
    vi.useRealTimers();
  });

  /**
   * A restore that can never land: a saved body offset makes the target
   * anchor-relative, and an anchor that generates no layout boxes (detached
   * here; a Suspense fallback window in production) yields no measurement, so
   * every frame holds instead of writing. That is the state all three
   * `yielded` reasons require — the mark exists precisely to make a restore
   * that never landed visible instead of silent.
   */
  function renderNeverLandingRestore(docName: string) {
    rememberDocScrollState(docName, { offset: 300, mode: 'wysiwyg', fraction: 0.1 });
    const anchorRef: RefObject<HTMLElement | null> = { current: document.createElement('div') };
    const { container } = render(<Harness active docName={docName} anchorRef={anchorRef} />);
    const scroller = scrollerOf(container);
    expect(scroller.scrollTop).toBe(0); // held: no valid evidence to write through
    return scroller;
  }

  test('a user scroll during a restore that never landed is reported, with geometry', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const scroller = renderNeverLandingRestore('doc-yield-user');
      scroller.dispatchEvent(new WheelEvent('wheel'));
      // Exact match, not containment: a dropped field is the failure this
      // guards. `contentBottom` is deliberately absent — the loop passes no
      // extent to the yielded marks.
      expect(breadcrumbLines(info)).toEqual([
        {
          event: 'ok/scroll-restore/yielded',
          docName: 'doc-yield-user',
          reason: 'user',
          elapsedMs: expect.any(Number),
          scrollTop: 0,
          scrollHeight: 5000,
          clientHeight: 0,
        },
      ]);
    } finally {
      info.mockRestore();
    }
  });

  test('a landing taking over mid-restore is reported as its own reason', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      renderNeverLandingRestore('doc-yield-landing');
      // Acquired AFTER mount: acquiring first makes the layout effect stand
      // down at setup, and there is then no restore to take over.
      acquireScrollRestoreSuppression('doc-yield-landing', 'landing');
      vi.advanceTimersByTime(ONE_FRAME_MS);
      // Two lines, not one: a takeover that finds a holder reports WHO has the
      // scroller now (`superseded`) as well as that this restore never landed
      // (`yielded`). Both reach a bundle, so both are asserted whole — a
      // `superseded` line that stopped naming its document would otherwise pass
      // here unread.
      expect(breadcrumbLines(info)).toEqual([
        {
          event: 'ok/scroll-restore/superseded',
          docName: 'doc-yield-landing',
          holder: 'landing',
          elapsedMs: expect.any(Number),
          finalScrollTop: 0,
        },
        {
          event: 'ok/scroll-restore/yielded',
          docName: 'doc-yield-landing',
          reason: 'landing',
          elapsedMs: expect.any(Number),
          scrollTop: 0,
          scrollHeight: 5000,
          clientHeight: 0,
        },
      ]);
    } finally {
      info.mockRestore();
    }
  });

  test('an upward scroll we did not write is reported as an external takeover', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const scroller = renderNeverLandingRestore('doc-yield-external');
      // What an outline click or find-in-doc does: moves the scroller UP from
      // where the loop left it, between two of its frames.
      scroller.scrollTop = 300;
      vi.advanceTimersByTime(ONE_FRAME_MS);
      expect(breadcrumbLines(info)).toEqual([
        {
          event: 'ok/scroll-restore/yielded',
          docName: 'doc-yield-external',
          reason: 'external',
          elapsedMs: expect.any(Number),
          scrollTop: 300,
          scrollHeight: 5000,
          clientHeight: 0,
        },
      ]);
    } finally {
      info.mockRestore();
    }
  });

  test('a restore the layout can never satisfy is reported at the backstop', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      // Runway enough to keep trying (scrollHeight reaches past the target) but
      // never enough to arrive: the scroller clamps every write to 200 while
      // the target stays 500, so the loop re-applies until the backstop and
      // this mark is the only record that the position was never reached.
      stubScrollHeight = 1000;
      stubClientHeight = 800;
      const { container } = render(<Harness active docName="doc-abandon" />);
      expect(scrollerOf(container).scrollTop).toBe(200);
      vi.advanceTimersByTime(RESTORE_BACKSTOP_MS);
      expect(breadcrumbLines(info)).toEqual([
        {
          event: 'ok/scroll-restore/abandoned',
          docName: 'doc-abandon',
          target: 500,
          anchorMeasurable: true,
          elapsedMs: expect.any(Number),
          scrollTop: 200,
          scrollHeight: 1000,
          clientHeight: 800,
        },
      ]);
    } finally {
      info.mockRestore();
    }
  });

  test('a re-apply after the height collapses and regrows is reported as phase 2', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const { container } = render(<Harness active docName="doc-phase2" />);
      const scroller = scrollerOf(container);
      expect(scroller.scrollTop).toBe(500); // phase 1 landed

      // The warm-fallback -> real-editor swap: content height collapses, which
      // re-clamps the scroller downward — a shrink-clamp, not a takeover...
      stubScrollHeight = 100;
      reclampToCurrentHeight(scroller);
      expect(scroller.scrollTop).toBe(100);
      vi.advanceTimersByTime(ONE_FRAME_MS); // no runway below the target: hold
      expect(scroller.scrollTop).toBe(100);

      // ...and regrows once the real editor hydrates, which is the frame the
      // poll exists for.
      stubScrollHeight = 5000;
      vi.advanceTimersByTime(ONE_FRAME_MS);
      expect(scroller.scrollTop).toBe(500);

      expect(breadcrumbLines(info)).toEqual([
        {
          event: 'ok/scroll-restore/phase1-success',
          docName: 'doc-phase2',
          target: 500,
          elapsedMs: expect.any(Number),
          scrollTop: 500,
          scrollHeight: 5000,
          clientHeight: 0,
        },
        {
          event: 'ok/scroll-restore/phase2-success',
          docName: 'doc-phase2',
          target: 500,
          elapsedMs: expect.any(Number),
          scrollTop: 500,
          scrollHeight: 5000,
          clientHeight: 0,
        },
      ]);
    } finally {
      info.mockRestore();
    }
  });
});
