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
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  __resetScrollRestoreCoordination,
  acquireScrollRestoreSuppression,
  rememberDocScrollState,
} from '@/editor/scroll-restore-coordination';
import type { EditorModeValue } from '@/editor/use-editor-mode';
import { getCollector } from '@/lib/perf/collector';
import { ScrollPreservingContainer } from './EditorActivityPool';

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
      scrollTops.set(this, value);
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

function crossModeMark(): { properties?: Record<string, unknown> } | undefined {
  return getCollector()
    ?.marks.toArray()
    .find((m) => m.name === 'ok/scroll-restore/cross-mode');
}

function Harness({
  active,
  docName,
  mode = 'wysiwyg',
  initialScrollTop = 500,
}: {
  active: boolean;
  docName: string;
  mode?: EditorModeValue;
  initialScrollTop?: number;
}) {
  return (
    <ScrollPreservingContainer
      isActive={active}
      docName={docName}
      mode={mode}
      initialScrollTop={initialScrollTop}
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
