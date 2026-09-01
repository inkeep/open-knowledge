// @vitest-environment jsdom

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

function reclampToCurrentHeight(el: HTMLElement) {
  const current = el.scrollTop;
  el.scrollTop = current;
}

function crossModeMark(): { properties?: Record<string, unknown> } | undefined {
  return getCollector()
    ?.marks.toArray()
    .find((m) => m.name === 'ok/scroll-restore/cross-mode');
}

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
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      render(<Harness active docName="doc-geo" />);
      const lines = breadcrumbLines(info);
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
    rerender(<Harness active docName="doc-c" />);
    expect(scrollerOf(container).scrollTop).toBe(0);
    handle.release();
    rerender(<Harness active={false} docName="doc-c" />);
    rerender(<Harness active docName="doc-c" />);
    expect(scrollerOf(container).scrollTop).toBe(500);
  });
});

describe('ScrollPreservingContainer cross-mode re-activation floor', () => {
  test('lands proportionally instead of driving the other mode saved offset', () => {
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
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      rememberDocScrollState('doc-x', { offset: 4321, mode: 'source', fraction: 0.4 });
      render(<Harness active docName="doc-x" mode="wysiwyg" initialScrollTop={0} />);
      const lines = breadcrumbLines(info);
      expect(lines).toEqual([
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
    rememberDocScrollState('doc-y', { offset: 4321, mode: 'wysiwyg', fraction: 0.4 });
    const { container } = render(
      <Harness active docName="doc-y" mode="wysiwyg" initialScrollTop={777} />,
    );
    expect(scrollerOf(container).scrollTop).toBe(777);
    expect(crossModeMark()).toBeUndefined();
  });

  test('marks applied:false when the new mode content cannot be scrolled', () => {
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

describe('ScrollPreservingContainer restore-outcome marks', () => {
  const ONE_FRAME_MS = 20;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'],
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function renderNeverLandingRestore(docName: string) {
    rememberDocScrollState(docName, { offset: 300, mode: 'wysiwyg', fraction: 0.1 });
    const anchorRef: RefObject<HTMLElement | null> = { current: document.createElement('div') };
    const { container } = render(<Harness active docName={docName} anchorRef={anchorRef} />);
    const scroller = scrollerOf(container);
    expect(scroller.scrollTop).toBe(0);
    return scroller;
  }

  test('a user scroll during a restore that never landed is reported, with geometry', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const scroller = renderNeverLandingRestore('doc-yield-user');
      scroller.dispatchEvent(new WheelEvent('wheel'));
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
      acquireScrollRestoreSuppression('doc-yield-landing', 'landing');
      vi.advanceTimersByTime(ONE_FRAME_MS);
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
      expect(scroller.scrollTop).toBe(500);

      stubScrollHeight = 100;
      reclampToCurrentHeight(scroller);
      expect(scroller.scrollTop).toBe(100);
      vi.advanceTimersByTime(ONE_FRAME_MS);
      expect(scroller.scrollTop).toBe(100);

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
