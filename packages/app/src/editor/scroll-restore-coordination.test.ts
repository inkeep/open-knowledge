// @vitest-environment jsdom
/**
 * Coverage for the scroll-restore coordination surface: the per-document
 * body-offset map (persistence + LRU cap), the landing-result writer, the
 * ref-counted suppression registry a landing uses to become the single scroll
 * writer, and the landing-owner registry that lets an explicit navigation take
 * that role back. The anchor-measurement primitive the writer consumes is
 * `measureAnchor`, pinned in components/scroll-restore.test.ts.
 * `writeLandingResult` builds real DOM (`document.createElement`,
 * `getBoundingClientRect`, `querySelector`), so this file opts into jsdom via
 * the per-file docblock above. It is NOT a Tier-3 React mount test — no
 * component render — so it stays `.test.ts`, not `.dom.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __resetScrollRestoreCoordination,
  acquireScrollRestoreSuppression,
  BODY_ANCHOR_ATTR,
  claimScrollerForNavigation,
  type DocScrollState,
  getDocScrollState,
  isScrollRestoreSuppressed,
  type LandingScrollOwner,
  MAX_TRACKED_DOC_SCROLL,
  registerLandingScrollOwner,
  rememberDocScrollState,
  runScrollNavigation,
  scrollFraction,
  writeLandingResult,
} from './scroll-restore-coordination';
import type { EditorModeValue } from './use-editor-mode';

// Terse builder — most persistence/LRU cases care only about the offset, so
// they leave mode/fraction at defaults.
function state(offset: number, mode: EditorModeValue = 'wysiwyg', fraction = 0): DocScrollState {
  return { offset, mode, fraction };
}

beforeEach(() => {
  __resetScrollRestoreCoordination();
});

afterEach(() => {
  __resetScrollRestoreCoordination();
  vi.restoreAllMocks();
});

// A detached element with fixed layout geometry — jsdom returns an all-zero
// rect, an empty client-rect list, and a no-op scrollTop, so the math needs
// deterministic stand-ins. `boxes` is what makes the element laid out: an
// element with none is `unmeasurable` to `measureAnchor` (display:none /
// detached), which is a real case the landing writer has to handle.
function elementAt(top: number, scrollTop = 0, boxes = 1): HTMLElement {
  const el = document.createElement('div');
  vi.spyOn(el, 'getClientRects').mockReturnValue({ length: boxes } as DOMRectList);
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    top,
    bottom: top,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: scrollTop });
  return el;
}

describe('scroll-restore state persistence', () => {
  test('a document with no remembered state reads back undefined', () => {
    expect(getDocScrollState('never-written')).toBeUndefined();
  });

  test('remembers and reads back a document offset', () => {
    rememberDocScrollState('doc', state(42));
    expect(getDocScrollState('doc')?.offset).toBe(42);
  });

  test('records the mode the position was captured in so a restore can tell same- from cross-mode', () => {
    rememberDocScrollState('doc', state(42, 'source', 0.4));
    expect(getDocScrollState('doc')?.mode).toBe('source');
    expect(getDocScrollState('doc')?.fraction).toBe(0.4);
  });

  test('a later write for the same document overwrites the earlier one', () => {
    rememberDocScrollState('doc', state(42, 'wysiwyg'));
    rememberDocScrollState('doc', state(99, 'source'));
    expect(getDocScrollState('doc')?.offset).toBe(99);
    expect(getDocScrollState('doc')?.mode).toBe('source');
  });

  test('evicts the least-recently-written document once capacity is exceeded', () => {
    for (let i = 0; i <= MAX_TRACKED_DOC_SCROLL; i++) rememberDocScrollState(`k${i}`, state(i));
    expect(getDocScrollState('k0')).toBeUndefined();
    expect(getDocScrollState(`k${MAX_TRACKED_DOC_SCROLL}`)?.offset).toBe(MAX_TRACKED_DOC_SCROLL);
  });

  test('re-writing a document refreshes its recency so it is not the next evicted', () => {
    for (let i = 0; i < MAX_TRACKED_DOC_SCROLL; i++) rememberDocScrollState(`k${i}`, state(i));
    rememberDocScrollState('k0', state(1000)); // touch the oldest → moves it to most-recent
    rememberDocScrollState('overflow', state(-1)); // one over capacity → evicts the now-oldest (k1)
    expect(getDocScrollState('k0')?.offset).toBe(1000);
    expect(getDocScrollState('k1')).toBeUndefined();
  });
});

describe('scrollFraction', () => {
  test('is the ratio of scrollTop to the scrollable range', () => {
    // range = 5000 - 1000 = 4000; 1000 / 4000 = 0.25
    expect(scrollFraction(1000, 5000, 1000)).toBe(0.25);
  });

  test('is zero when the content does not overflow (no scrollable range)', () => {
    expect(scrollFraction(0, 800, 800)).toBe(0);
    expect(scrollFraction(50, 500, 800)).toBe(0);
  });

  test('clamps into [0,1] for out-of-range inputs', () => {
    expect(scrollFraction(-100, 5000, 1000)).toBe(0);
    expect(scrollFraction(9999, 5000, 1000)).toBe(1);
  });
});

describe('writeLandingResult', () => {
  test('persists the target as a body-relative offset using an explicit anchor', () => {
    const container = elementAt(100, 50);
    const anchor = elementAt(300);
    writeLandingResult({
      docName: 'doc',
      container,
      targetScrollTop: 1000,
      mode: 'source',
      anchor,
    });
    // targetScrollTop - anchorPos(250) = 750, so a later restore at the same
    // anchor reproduces scrollTop 1000.
    expect(getDocScrollState('doc')?.offset).toBe(750);
  });

  test('stamps the mode the landing landed in', () => {
    const container = elementAt(100, 50);
    writeLandingResult({ docName: 'doc', container, targetScrollTop: 1000, mode: 'source' });
    expect(getDocScrollState('doc')?.mode).toBe('source');
  });

  test('records the landing fraction from the container scroll range', () => {
    const container = elementAt(100, 0);
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 5000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 1000 });
    writeLandingResult({ docName: 'doc', container, targetScrollTop: 1000, mode: 'source' });
    // 1000 / (5000 - 1000) = 0.25
    expect(getDocScrollState('doc')?.fraction).toBe(0.25);
  });

  test('finds the body anchor via its marker attribute when none is passed', () => {
    const container = elementAt(100, 50);
    const anchor = elementAt(300);
    anchor.setAttribute(BODY_ANCHOR_ATTR, '');
    container.appendChild(anchor);
    writeLandingResult({ docName: 'doc', container, targetScrollTop: 1000, mode: 'wysiwyg' });
    expect(getDocScrollState('doc')?.offset).toBe(750);
  });

  test('falls back to the raw target when the container has no body anchor', () => {
    const container = elementAt(100, 50);
    writeLandingResult({ docName: 'doc', container, targetScrollTop: 1000, mode: 'wysiwyg' });
    expect(getDocScrollState('doc')?.offset).toBe(1000);
  });

  test('takes the raw fallback for an anchor with no layout boxes, never its zero rect', () => {
    // A mounted-but-hidden anchor reports a rect at the viewport origin.
    // Measuring it would store `targetScrollTop - (0 - containerTop +
    // scrollTop)` — the self-amplifying offset the restore loop then feeds
    // back into itself, one frame at a time.
    const container = elementAt(100, 50);
    const hiddenAnchor = elementAt(0, 0, 0);
    writeLandingResult({
      docName: 'doc',
      container,
      targetScrollTop: 1000,
      mode: 'wysiwyg',
      anchor: hiddenAnchor,
    });
    expect(getDocScrollState('doc')?.offset).toBe(1000);
  });
});

describe('scroll-restore suppression registry', () => {
  test('a document is not suppressed until a handle is acquired', () => {
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('acquiring a handle suppresses the document; releasing it re-enables restore', () => {
    const handle = acquireScrollRestoreSuppression('doc');
    expect(isScrollRestoreSuppressed('doc')).toBe(true);
    handle.release();
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('overlapping holders each keep suppression until all release', () => {
    const first = acquireScrollRestoreSuppression('doc');
    const second = acquireScrollRestoreSuppression('doc');
    first.release();
    expect(isScrollRestoreSuppressed('doc')).toBe(true); // second still holds
    second.release();
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('releasing the same handle twice does not underflow another holder', () => {
    const first = acquireScrollRestoreSuppression('doc');
    const second = acquireScrollRestoreSuppression('doc');
    first.release();
    first.release(); // idempotent — must not decrement second's hold
    expect(isScrollRestoreSuppressed('doc')).toBe(true);
    second.release();
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('suppression is scoped per document', () => {
    const handle = acquireScrollRestoreSuppression('a');
    expect(isScrollRestoreSuppressed('a')).toBe(true);
    expect(isScrollRestoreSuppressed('b')).toBe(false);
    handle.release();
  });
});

describe('landing scroll owners and explicit navigation', () => {
  /**
   * Register a landing owner that behaves like the controller's: superseding it
   * releases its own registration. Reports how often it was superseded.
   */
  function ownLanding(docName: string, yieldsToNavigation: boolean): () => number {
    let superseded = 0;
    const registration = registerLandingScrollOwner(docName, {
      yieldsToNavigation,
      supersede: () => {
        superseded += 1;
        registration.release();
      },
    });
    return () => superseded;
  }

  test('an unowned scroller is free for a navigation', () => {
    const scroll = vi.fn();
    expect(runScrollNavigation('doc', scroll)).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  test('a yielding owner is superseded and the navigation runs', () => {
    const superseded = ownLanding('doc', true);
    const scroll = vi.fn();

    expect(runScrollNavigation('doc', scroll)).toBe(true);

    expect(superseded()).toBe(1);
    expect(scroll).toHaveBeenCalledTimes(1);
    // Superseding released the registration, so the next navigation is free.
    expect(claimScrollerForNavigation('doc')).toBe(true);
    expect(superseded()).toBe(1);
  });

  test('a non-yielding owner keeps the scroller and the navigation does not run', () => {
    const superseded = ownLanding('doc', false);
    const scroll = vi.fn();

    expect(runScrollNavigation('doc', scroll)).toBe(false);

    expect(superseded()).toBe(0);
    expect(scroll).not.toHaveBeenCalled();
  });

  test('overlapping yielding owners are all superseded', () => {
    const first = ownLanding('doc', true);
    const second = ownLanding('doc', true);

    expect(runScrollNavigation('doc', () => {})).toBe(true);

    expect(first()).toBe(1);
    expect(second()).toBe(1);
  });

  test('one non-yielding owner blocks the claim, superseding none of them', () => {
    // A partial pre-emption would tear down the yielding landing on behalf of a
    // navigation that then never runs.
    const yielding = ownLanding('doc', true);
    const holding = ownLanding('doc', false);

    expect(runScrollNavigation('doc', () => {})).toBe(false);

    expect(yielding()).toBe(0);
    expect(holding()).toBe(0);
  });

  test('a released owner no longer holds the scroller', () => {
    const supersede = vi.fn();
    const owner: LandingScrollOwner = { yieldsToNavigation: false, supersede };
    const registration = registerLandingScrollOwner('doc', owner);
    expect(claimScrollerForNavigation('doc')).toBe(false);

    registration.release();
    registration.release(); // idempotent

    expect(claimScrollerForNavigation('doc')).toBe(true);
    expect(supersede).not.toHaveBeenCalled();
  });

  test('ownership is scoped per document', () => {
    ownLanding('a', false);
    expect(claimScrollerForNavigation('a')).toBe(false);
    expect(claimScrollerForNavigation('b')).toBe(true);
  });
});
