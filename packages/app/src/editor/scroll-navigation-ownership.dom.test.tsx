// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ScrollPreservingContainer } from '@/components/EditorActivityPool';
import {
  __resetScrollRestoreCoordination,
  acquireScrollRestoreSuppression,
  registerLandingScrollOwner,
  runScrollNavigation,
} from '@/editor/scroll-restore-coordination';
import { getCollector } from '@/lib/perf/collector';

const DOC = 'notes/long-doubled-note';
const RESTORED_TOP = 4000;
const BACKWARD_TARGET = 500;
const FORWARD_TARGET = 4500;
const UNCLAIMED_DRIFT = 1200;
const OWNERSHIP_LAPSES_WITHIN_MS = 2_000;

const scrollTops = new WeakMap<HTMLElement, number>();
let stubScrollHeight = 20_000;
const CONTENT_TOO_SHORT_TO_LAND = 1_000;
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
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });
  __resetScrollRestoreCoordination();
  getCollector()?.reset();
  stubScrollHeight = 20_000;
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
      return 800;
    },
  });
});

afterEach(() => {
  cleanup();
  __resetScrollRestoreCoordination();
  vi.useRealTimers();
  restoreDescriptor('scrollTop', origScrollTop);
  restoreDescriptor('scrollHeight', origScrollHeight);
  restoreDescriptor('clientHeight', origClientHeight);
});

function letTheRestoreLoopRun(): void {
  vi.advanceTimersByTime(100);
}

function lapseNavigationOwnership(): void {
  vi.advanceTimersByTime(OWNERSHIP_LAPSES_WITHIN_MS);
}

function reappliedTarget(): unknown {
  return getCollector()
    ?.marks.toArray()
    .find((m) => m.name === 'ok/scroll-restore/phase2-success')?.properties?.target;
}

function yieldedReason(): unknown {
  return getCollector()
    ?.marks.toArray()
    .find((m) => m.name === 'ok/scroll-restore/yielded')?.properties?.reason;
}

function landedTarget(): unknown {
  return getCollector()
    ?.marks.toArray()
    .find((m) => m.name === 'ok/scroll-restore/phase1-success')?.properties?.target;
}

function supersededHolder(): unknown {
  return getCollector()
    ?.marks.toArray()
    .find((m) => m.name === 'ok/scroll-restore/superseded')?.properties?.holder;
}

function activate(from: number): HTMLDivElement {
  const { container } = render(
    <ScrollPreservingContainer isActive docName={DOC} mode="wysiwyg" initialScrollTop={from}>
      <div>document body</div>
    </ScrollPreservingContainer>,
  );
  const el = container.querySelector<HTMLDivElement>('[data-testid="editor-scroll-container"]');
  if (!el) throw new Error('editor-scroll-container not rendered');
  return el;
}

function mountWithLiveRestore(): HTMLDivElement {
  const el = activate(RESTORED_TOP);
  if (el.scrollTop !== RESTORED_TOP) {
    throw new Error(`harness precondition failed: restore did not seed ${RESTORED_TOP}`);
  }
  return el;
}

describe('an explicit navigation taken while the scroll-restore loop is live', () => {
  test('survives when it moves the reader UP the document', () => {
    const scroller = mountWithLiveRestore();

    const ran = runScrollNavigation(DOC, 'outline', () => {
      scroller.scrollTop = BACKWARD_TARGET;
    });

    expect(ran).toBe(true);
    letTheRestoreLoopRun();
    expect(scroller.scrollTop).toBe(BACKWARD_TARGET);
    expect(reappliedTarget()).toBeUndefined();

    lapseNavigationOwnership();
    letTheRestoreLoopRun();
    expect(scroller.scrollTop).toBe(BACKWARD_TARGET);
    expect(reappliedTarget()).toBeUndefined();
  });

  test('survives when it moves the reader DOWN the document', () => {
    const scroller = mountWithLiveRestore();

    const ran = runScrollNavigation(DOC, 'outline', () => {
      scroller.scrollTop = FORWARD_TARGET;
    });

    expect(ran).toBe(true);
    letTheRestoreLoopRun();
    expect(scroller.scrollTop).toBe(FORWARD_TARGET);
    expect(reappliedTarget()).toBeUndefined();
  });

  test('a refused navigation neither scrolls nor stands the restore down', () => {
    const scroller = mountWithLiveRestore();
    registerLandingScrollOwner(DOC, { yieldsToNavigation: false, supersede: () => {} });

    const ran = runScrollNavigation(DOC, 'outline', () => {
      scroller.scrollTop = BACKWARD_TARGET;
    });

    expect(ran).toBe(false);
    expect(scroller.scrollTop).toBe(RESTORED_TOP);

    scroller.scrollTop = UNCLAIMED_DRIFT;
    letTheRestoreLoopRun();
    expect(scroller.scrollTop).toBe(RESTORED_TOP);
  });

  test('holds the scroller only while it lands, so the document restores again later', () => {
    const scroller = mountWithLiveRestore();
    runScrollNavigation(DOC, 'outline', () => {
      scroller.scrollTop = BACKWARD_TARGET;
    });
    letTheRestoreLoopRun();

    lapseNavigationOwnership();
    cleanup();
    getCollector()?.reset();

    const reactivated = mountWithLiveRestore();
    reactivated.scrollTop = UNCLAIMED_DRIFT;
    letTheRestoreLoopRun();

    expect(reactivated.scrollTop).toBe(RESTORED_TOP);
    expect(reappliedTarget()).toBe(RESTORED_TOP);
  });

  test('a document re-activated INSIDE the hold still restores the reader', () => {
    const scroller = mountWithLiveRestore();
    runScrollNavigation(DOC, 'outline', () => {
      scroller.scrollTop = BACKWARD_TARGET;
    });
    letTheRestoreLoopRun();

    cleanup();
    getCollector()?.reset();
    const reactivated = activate(BACKWARD_TARGET);

    expect(reactivated.scrollTop).toBe(BACKWARD_TARGET);
  });

  test('the loop reports WHO took the scroller, not a fixed holder', () => {
    stubScrollHeight = CONTENT_TOO_SHORT_TO_LAND;
    const scroller = mountWithLiveRestore();

    runScrollNavigation(DOC, 'outline', () => {
      scroller.scrollTop = BACKWARD_TARGET;
    });
    letTheRestoreLoopRun();

    expect(yieldedReason()).toBe('navigation');
  });

  test('and reports a landing as a landing', () => {
    stubScrollHeight = CONTENT_TOO_SHORT_TO_LAND;
    const scroller = mountWithLiveRestore();

    acquireScrollRestoreSuppression(DOC, 'landing');
    scroller.scrollTop = BACKWARD_TARGET;
    letTheRestoreLoopRun();

    expect(yieldedReason()).toBe('landing');
  });

  test('reports the handover even when the restore had already landed', () => {
    const scroller = mountWithLiveRestore();
    expect(landedTarget()).toBe(RESTORED_TOP);

    runScrollNavigation(DOC, 'outline', () => {
      scroller.scrollTop = BACKWARD_TARGET;
    });
    letTheRestoreLoopRun();

    expect(supersededHolder()).toBe('navigation');
    expect(yieldedReason()).toBeUndefined();
  });

  test('and names a landing handover the same way', () => {
    const scroller = mountWithLiveRestore();

    acquireScrollRestoreSuppression(DOC, 'landing');
    scroller.scrollTop = BACKWARD_TARGET;
    letTheRestoreLoopRun();

    expect(supersededHolder()).toBe('landing');
  });

  test('a document re-activated inside a LANDING still stands down', () => {
    acquireScrollRestoreSuppression(DOC, 'landing');

    const reactivated = activate(RESTORED_TOP);

    expect(reactivated.scrollTop).toBe(0);
  });
});
