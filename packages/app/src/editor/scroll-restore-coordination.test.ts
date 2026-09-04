// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getCollector } from '@/lib/perf/collector';
import {
  __resetScrollRestoreCoordination,
  acquireScrollRestoreSuppression,
  BODY_ANCHOR_ATTR,
  claimScrollerForNavigation,
  type DocScrollState,
  getDocScrollState,
  isScrollRestoreSuppressed,
  type LandingScrollOwner,
  MAX_TRACKED_DECLINE_DOCS,
  MAX_TRACKED_DOC_SCROLL,
  registerLandingScrollOwner,
  rememberDocScrollState,
  runScrollNavigation,
  scrollFraction,
  scrollSuppressionHolder,
  writeLandingResult,
} from './scroll-restore-coordination';
import type { EditorModeValue } from './use-editor-mode';

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
    rememberDocScrollState('k0', state(1000));
    rememberDocScrollState('overflow', state(-1));
    expect(getDocScrollState('k0')?.offset).toBe(1000);
    expect(getDocScrollState('k1')).toBeUndefined();
  });
});

describe('scrollFraction', () => {
  test('is the ratio of scrollTop to the scrollable range', () => {
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
    const handle = acquireScrollRestoreSuppression('doc', 'landing');
    expect(isScrollRestoreSuppressed('doc')).toBe(true);
    handle.release();
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('overlapping holders each keep suppression until all release', () => {
    const first = acquireScrollRestoreSuppression('doc', 'landing');
    const second = acquireScrollRestoreSuppression('doc', 'landing');
    first.release();
    expect(isScrollRestoreSuppressed('doc')).toBe(true);
    second.release();
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('releasing the same handle twice does not underflow another holder', () => {
    const first = acquireScrollRestoreSuppression('doc', 'landing');
    const second = acquireScrollRestoreSuppression('doc', 'landing');
    first.release();
    first.release();
    expect(isScrollRestoreSuppressed('doc')).toBe(true);
    second.release();
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('suppression is scoped per document', () => {
    const handle = acquireScrollRestoreSuppression('a', 'landing');
    expect(isScrollRestoreSuppressed('a')).toBe(true);
    expect(isScrollRestoreSuppressed('b')).toBe(false);
    handle.release();
  });
});

describe('the holder behind a document suppression', () => {
  test('nobody holds an unsuppressed document', () => {
    expect(scrollSuppressionHolder('doc')).toBeNull();
  });

  test('each kind names itself', () => {
    const landing = acquireScrollRestoreSuppression('doc', 'landing');
    expect(scrollSuppressionHolder('doc')).toBe('landing');
    landing.release();

    const navigation = acquireScrollRestoreSuppression('doc', 'navigation');
    expect(scrollSuppressionHolder('doc')).toBe('navigation');
    navigation.release();
    expect(scrollSuppressionHolder('doc')).toBeNull();
  });

  test('a landing outranks a navigation while both hold', () => {
    const navigation = acquireScrollRestoreSuppression('doc', 'navigation');
    const landing = acquireScrollRestoreSuppression('doc', 'landing');

    expect(scrollSuppressionHolder('doc')).toBe('landing');

    navigation.release();
    expect(scrollSuppressionHolder('doc')).toBe('landing');
    landing.release();
    expect(scrollSuppressionHolder('doc')).toBeNull();
  });

  test('releasing one kind does not clear the other, in either order', () => {
    const landingFirst = acquireScrollRestoreSuppression('doc', 'landing');
    acquireScrollRestoreSuppression('doc', 'navigation');
    landingFirst.release();
    expect(scrollSuppressionHolder('doc')).toBe('navigation');
  });

  test('a handle issued before a reset cannot decrement what came after', () => {
    const stale = acquireScrollRestoreSuppression('doc', 'landing');
    __resetScrollRestoreCoordination();
    const fresh = acquireScrollRestoreSuppression('doc', 'landing');

    stale.release();

    expect(scrollSuppressionHolder('doc')).toBe('landing');
    fresh.release();
    expect(scrollSuppressionHolder('doc')).toBeNull();
  });
});

describe('landing scroll owners and explicit navigation', () => {
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
    expect(runScrollNavigation('doc', 'outline', scroll)).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  test('a yielding owner is superseded and the navigation runs', () => {
    const superseded = ownLanding('doc', true);
    const scroll = vi.fn();

    expect(runScrollNavigation('doc', 'outline', scroll)).toBe(true);

    expect(superseded()).toBe(1);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(claimScrollerForNavigation('doc', 'find-match')).toBe(true);
    expect(superseded()).toBe(1);
  });

  test('a non-yielding owner keeps the scroller and the navigation does not run', () => {
    const superseded = ownLanding('doc', false);
    const scroll = vi.fn();

    expect(runScrollNavigation('doc', 'outline', scroll)).toBe(false);

    expect(superseded()).toBe(0);
    expect(scroll).not.toHaveBeenCalled();
  });

  test('overlapping yielding owners are all superseded', () => {
    const first = ownLanding('doc', true);
    const second = ownLanding('doc', true);

    expect(runScrollNavigation('doc', 'outline', () => {})).toBe(true);

    expect(first()).toBe(1);
    expect(second()).toBe(1);
  });

  test('one non-yielding owner blocks the claim, superseding none of them', () => {
    const yielding = ownLanding('doc', true);
    const holding = ownLanding('doc', false);

    expect(runScrollNavigation('doc', 'outline', () => {})).toBe(false);

    expect(yielding()).toBe(0);
    expect(holding()).toBe(0);
  });

  test('a released owner no longer holds the scroller', () => {
    const supersede = vi.fn();
    const owner: LandingScrollOwner = { yieldsToNavigation: false, supersede };
    const registration = registerLandingScrollOwner('doc', owner);
    expect(claimScrollerForNavigation('doc', 'find-match')).toBe(false);

    registration.release();
    registration.release();

    expect(claimScrollerForNavigation('doc', 'find-match')).toBe(true);
    expect(supersede).not.toHaveBeenCalled();
  });

  test('ownership is scoped per document', () => {
    ownLanding('a', false);
    expect(claimScrollerForNavigation('a', 'find-match')).toBe(false);
    expect(claimScrollerForNavigation('b', 'find-match')).toBe(true);
  });
});

describe('an explicit navigation stands the scroll-restore loop down', () => {
  const OWNERSHIP_LAPSES_WITHIN_MS = 2_000;

  const NAVIGATION_DECLINED_MARK = 'ok/scroll-nav/declined';

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
    getCollector()?.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function lapseOwnership(): void {
    vi.advanceTimersByTime(OWNERSHIP_LAPSES_WITHIN_MS);
  }

  function ownLandingThatNeverYields(docName: string): void {
    registerLandingScrollOwner(docName, { yieldsToNavigation: false, supersede: () => {} });
  }

  function declinedNavigations(): unknown[] {
    return (getCollector()?.marks.toArray() ?? [])
      .filter((m) => m.name === NAVIGATION_DECLINED_MARK)
      .map((m) => m.properties);
  }

  test('the restore loop is suppressed for the whole of the caller write', () => {
    let suppressedDuringWrite: boolean | undefined;

    const ran = runScrollNavigation('doc', 'outline', () => {
      suppressedDuringWrite = isScrollRestoreSuppressed('doc');
    });

    expect(ran).toBe(true);
    expect(suppressedDuringWrite).toBe(true);
  });

  test('the suppression outlives the call, because the loop measures a frame later', () => {
    runScrollNavigation('doc', 'outline', () => {});

    expect(isScrollRestoreSuppressed('doc')).toBe(true);
  });

  test('and then lapses — a navigation borrows the scroller, it does not keep it', () => {
    runScrollNavigation('doc', 'outline', () => {});

    lapseOwnership();

    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('successive navigations each release their own hold', () => {
    runScrollNavigation('doc', 'outline', () => {});
    runScrollNavigation('doc', 'outline', () => {});

    lapseOwnership();

    expect(isScrollRestoreSuppressed('doc')).toBe(false);
    expect(runScrollNavigation('doc', 'outline', () => {})).toBe(true);
    expect(isScrollRestoreSuppressed('doc')).toBe(true);
  });

  test('suppression is scoped to the navigated document', () => {
    runScrollNavigation('doc', 'outline', () => {});

    expect(isScrollRestoreSuppressed('other')).toBe(false);
  });

  test('the hold is taken before a superseded landing lets go of its own', () => {
    const landing = acquireScrollRestoreSuppression('doc', 'landing');
    let suppressedDuringHandover: boolean | undefined;
    registerLandingScrollOwner('doc', {
      yieldsToNavigation: true,
      supersede: () => {
        landing.release();
        suppressedDuringHandover = isScrollRestoreSuppressed('doc');
      },
    });

    expect(runScrollNavigation('doc', 'outline', () => {})).toBe(true);

    expect(suppressedDuringHandover).toBe(true);
  });

  test('a refused navigation suppresses nothing', () => {
    ownLandingThatNeverYields('doc');

    expect(runScrollNavigation('doc', 'outline', () => {})).toBe(false);

    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('a refused navigation is recorded, not silently swallowed', () => {
    ownLandingThatNeverYields('doc');

    expect(runScrollNavigation('doc', 'outline', () => {})).toBe(false);

    expect(declinedNavigations()).toEqual([
      expect.objectContaining({ docName: 'doc', seam: 'outline', ownerCount: 1 }),
    ]);
  });

  test('a completed navigation is not recorded as refused', () => {
    runScrollNavigation('doc', 'outline', () => {});

    expect(declinedNavigations()).toEqual([]);
  });

  test('a polling seam records one refusal episode, not one entry per attempt', () => {
    ownLandingThatNeverYields('doc');

    for (let attempt = 0; attempt < 25; attempt += 1) {
      expect(runScrollNavigation('doc', 'deep-link', () => {})).toBe(false);
    }

    expect(declinedNavigations()).toHaveLength(1);
  });

  test('a second seam refused in the same window is recorded separately', () => {
    ownLandingThatNeverYields('doc');

    runScrollNavigation('doc', 'deep-link', () => {});
    runScrollNavigation('doc', 'outline', () => {});

    expect(declinedNavigations().map((p) => (p as { seam: string }).seam)).toEqual([
      'deep-link',
      'outline',
    ]);
  });

  test('a navigation that gets through re-arms the next refusal', () => {
    const registration = registerLandingScrollOwner('doc', {
      yieldsToNavigation: false,
      supersede: () => {},
    });
    runScrollNavigation('doc', 'outline', () => {});
    registration.release();
    expect(runScrollNavigation('doc', 'outline', () => {})).toBe(true);
    ownLandingThatNeverYields('doc');

    runScrollNavigation('doc', 'outline', () => {});

    expect(declinedNavigations()).toHaveLength(2);
  });

  test('the refusal streak map does not grow without bound', () => {
    const first = 'doc-0';
    ownLandingThatNeverYields(first);
    expect(runScrollNavigation(first, 'outline', () => {})).toBe(false);
    expect(runScrollNavigation(first, 'deep-link', () => {})).toBe(false);

    for (let i = 1; i <= MAX_TRACKED_DECLINE_DOCS; i += 1) {
      const later = `doc-${i}`;
      ownLandingThatNeverYields(later);
      runScrollNavigation(later, 'outline', () => {});
    }

    runScrollNavigation(first, 'outline', () => {});
    runScrollNavigation(first, 'deep-link', () => {});

    expect(
      declinedNavigations().filter((props) => (props as { docName: string }).docName === first),
    ).toHaveLength(4);
  });

  test('the bare claim carries the same guarantee', () => {
    expect(claimScrollerForNavigation('doc', 'find-match')).toBe(true);
    expect(isScrollRestoreSuppressed('doc')).toBe(true);

    lapseOwnership();

    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('a refused bare claim suppresses nothing', () => {
    ownLandingThatNeverYields('doc');

    expect(claimScrollerForNavigation('doc', 'find-match')).toBe(false);

    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('a reset revokes a pending release, so it cannot cut short the next hold', () => {
    runScrollNavigation('doc', 'outline', () => {});

    __resetScrollRestoreCoordination();
    const landing = acquireScrollRestoreSuppression('doc', 'landing');
    lapseOwnership();

    expect(isScrollRestoreSuppressed('doc')).toBe(true);
    landing.release();
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });
});
