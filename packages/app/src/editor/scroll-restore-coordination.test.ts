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
    const handle = acquireScrollRestoreSuppression('doc', 'landing');
    expect(isScrollRestoreSuppressed('doc')).toBe(true);
    handle.release();
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('overlapping holders each keep suppression until all release', () => {
    const first = acquireScrollRestoreSuppression('doc', 'landing');
    const second = acquireScrollRestoreSuppression('doc', 'landing');
    first.release();
    expect(isScrollRestoreSuppressed('doc')).toBe(true); // second still holds
    second.release();
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('releasing the same handle twice does not underflow another holder', () => {
    const first = acquireScrollRestoreSuppression('doc', 'landing');
    const second = acquireScrollRestoreSuppression('doc', 'landing');
    first.release();
    first.release(); // idempotent — must not decrement second's hold
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

/**
 * WHICH writer holds the scroller, not just whether one does.
 *
 * A reader that runs every frame stands down for either kind and looks again
 * next frame. A reader that gets one chance — the container's activation
 * restore, the cached editor's warm-reparent write — writes now or never, and
 * the two kinds mean opposite things to it: a landing is going to write a
 * position of its own, so deferring preserves one; a navigation has already
 * written its position and is only defending it, so deferring loses one.
 *
 * Which makes RELEASE ORDER the property worth pinning. The two kinds overlap
 * routinely (a navigation taken across a landing handover), and a registry that
 * remembered only the most recent holder would answer `navigation` the moment a
 * navigation released out from under a landing that still holds — handing the
 * one-shot readers a green light in the middle of the settle window they exist
 * to stay out of.
 */
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

    // The landing is the one still placing a position, so it is the answer a
    // one-shot reader needs: standing down for it still leaves the document
    // somewhere deliberate.
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
    // A single last-writer-wins field would have been overwritten to 'landing'
    // and then cleared outright here, losing the navigation still holding.
    expect(scrollSuppressionHolder('doc')).toBe('navigation');
  });

  test('a handle issued before a reset cannot decrement what came after', () => {
    // `__resetScrollRestoreCoordination` discards the counts a handle refers to.
    // Releasing it afterwards must be inert rather than driving a later holder's
    // count to zero and stealing a hold it never took.
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
    expect(runScrollNavigation('doc', 'outline', scroll)).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  test('a yielding owner is superseded and the navigation runs', () => {
    const superseded = ownLanding('doc', true);
    const scroll = vi.fn();

    expect(runScrollNavigation('doc', 'outline', scroll)).toBe(true);

    expect(superseded()).toBe(1);
    expect(scroll).toHaveBeenCalledTimes(1);
    // Superseding released the registration, so the next navigation is free.
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
    // A partial pre-emption would tear down the yielding landing on behalf of a
    // navigation that then never runs.
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
    registration.release(); // idempotent

    expect(claimScrollerForNavigation('doc', 'find-match')).toBe(true);
    expect(supersede).not.toHaveBeenCalled();
  });

  test('ownership is scoped per document', () => {
    ownLanding('a', false);
    expect(claimScrollerForNavigation('a', 'find-match')).toBe(false);
    expect(claimScrollerForNavigation('b', 'find-match')).toBe(true);
  });
});

/**
 * The OTHER writer.
 *
 * `runScrollNavigation` pre-empts the landings that own a document's scroller —
 * but a landing is not the only thing that writes to it. The editor container's
 * scroll-restore loop is a per-frame writer of its own, and it has four ways to
 * stop: the suppression probe, its wheel/touchstart/mousedown/keydown listeners,
 * its directional takeover test, and a wall-clock backstop.
 *
 * Only the first of those is reachable by a navigation toward the TOP of the
 * document. The listeners answer to the user's own hands, the backstop is ten
 * seconds away, and the takeover test fires on a scrollTop INCREASE only — a
 * decrease is indistinguishable from the browser's shrink-clamp against a
 * transient height, so the loop reads a backward navigation as drift and
 * re-applies its own target over it, frame after frame, until the backstop
 * expires. What the user sees is a row that highlights while nothing moves, and
 * then the same click working some seconds later.
 *
 * Which of the two writers a given navigation collides with is not something a
 * caller can know, which is the whole reason this precedence is enforced by the
 * producer instead of by each writer remembering to ask. So the guarantee has to
 * be delivered in full: routing a scroll through this module means EVERY scroll
 * writer stands down for it, not just the one the module was built for first.
 * The cases below pin that promise through the module's public predicate — the
 * same one the restore loop reads.
 */
describe('an explicit navigation stands the scroll-restore loop down', () => {
  /**
   * Upper bound on how long a navigation may hold the flag.
   *
   * Not the implementation's value — a ceiling the contract has to respect. The
   * restore loop exits for good on the first frame it sees the flag, so a hold
   * measured in seconds buys nothing and costs the NEXT restore or landing for
   * this document: they read the same flag, and would stand down for a
   * navigation that finished long ago.
   */
  const OWNERSHIP_LAPSES_WITHIN_MS = 2_000;

  /** The diagnostic mark that makes a refused navigation attributable. */
  const NAVIGATION_DECLINED_MARK = 'ok/scroll-nav/declined';

  beforeEach(() => {
    // Frames are faked alongside timers so `lapseOwnership` covers a release on
    // either clock. Date/performance stay real — nothing here asserts on the
    // elapsed times the surrounding marks carry.
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

  /** Let a navigation's hold on the scroller lapse, on whichever clock it rides. */
  function lapseOwnership(): void {
    vi.advanceTimersByTime(OWNERSHIP_LAPSES_WITHIN_MS);
  }

  /** A landing that refuses to be pre-empted, so every claim against it fails. */
  function ownLandingThatNeverYields(docName: string): void {
    registerLandingScrollOwner(docName, { yieldsToNavigation: false, supersede: () => {} });
  }

  function declinedNavigations(): unknown[] {
    return (getCollector()?.marks.toArray() ?? [])
      .filter((m) => m.name === NAVIGATION_DECLINED_MARK)
      .map((m) => m.properties);
  }

  test('the restore loop is suppressed for the whole of the caller write', () => {
    // Held BEFORE the write, not after: the loop measures on the frame it first
    // sees the move, and a move it reads before the flag is a decrease to
    // correct rather than a takeover to respect.
    let suppressedDuringWrite: boolean | undefined;

    const ran = runScrollNavigation('doc', 'outline', () => {
      suppressedDuringWrite = isScrollRestoreSuppressed('doc');
    });

    expect(ran).toBe(true);
    expect(suppressedDuringWrite).toBe(true);
  });

  test('the suppression outlives the call, because the loop measures a frame later', () => {
    runScrollNavigation('doc', 'outline', () => {});

    // A hold scoped to the synchronous callback would be gone before the loop
    // ever looked, which is the same as never having held it at all.
    expect(isScrollRestoreSuppressed('doc')).toBe(true);
  });

  test('and then lapses — a navigation borrows the scroller, it does not keep it', () => {
    runScrollNavigation('doc', 'outline', () => {});

    lapseOwnership();

    // A hold that never lapses reads as "always suppressed" and disables scroll
    // restore for this document for the rest of the session, which trades a
    // ten-second dead click for a permanently dead restore.
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('successive navigations each release their own hold', () => {
    runScrollNavigation('doc', 'outline', () => {});
    runScrollNavigation('doc', 'outline', () => {});

    lapseOwnership();

    // Holders are ref-counted, so two acquisitions need two releases; a release
    // that fired twice would underflow the count out from under whichever
    // landing holds it next.
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
    expect(runScrollNavigation('doc', 'outline', () => {})).toBe(true);
    expect(isScrollRestoreSuppressed('doc')).toBe(true);
  });

  test('suppression is scoped to the navigated document', () => {
    runScrollNavigation('doc', 'outline', () => {});

    // The flag is per-document and so is the loop that reads it: navigating one
    // editor must not stop a pooled sibling from restoring.
    expect(isScrollRestoreSuppressed('other')).toBe(false);
  });

  test('the hold is taken before a superseded landing lets go of its own', () => {
    // A landing releases its own suppression handle from inside `supersede`. A
    // claim that acquired only afterwards would leave the count at zero across
    // that unwind, and the landing's teardown re-enables the browser's scroll
    // anchoring and runs its outcome callback inside exactly that gap — so the
    // document must never read as unsuppressed mid-handover.
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

    // Nothing scrolled, so there is nothing to defend — and standing the restore
    // down here would turn a dead click into a dead click that also cost the
    // reader their place.
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });

  test('a refused navigation is recorded, not silently swallowed', () => {
    ownLandingThatNeverYields('doc');

    expect(runScrollNavigation('doc', 'outline', () => {})).toBe(false);

    // For the outline and raw-MDX seams the refusal is an outcome nobody
    // downstream can see: they drop the boolean, so the row highlights, the
    // caret may already have moved, and the view does not. The seam rides along
    // because the other seams DO consume the boolean and retry, which makes the
    // same event a dead click at one call site and a late one at another.
    // `ownerCount` is a number, so it takes the count suffix this package uses
    // for one: a bare plural in a mark payload is an array here, and an operator
    // reading `owners: 2` would take it for a truncated list of who refused.
    expect(declinedNavigations()).toEqual([
      expect.objectContaining({ docName: 'doc', seam: 'outline', ownerCount: 1 }),
    ]);
  });

  test('a completed navigation is not recorded as refused', () => {
    runScrollNavigation('doc', 'outline', () => {});

    expect(declinedNavigations()).toEqual([]);
  });

  test('a polling seam records one refusal episode, not one entry per attempt', () => {
    // The comment reveal re-attempts on an 80ms ticker for ten seconds and the
    // deep-link ladder retries a hundred times; marking each would bury the
    // surrounding scroll-restore and mode-switch marks that identify WHICH
    // landing refused, in the same ring, destroying the attribution this mark
    // exists to provide.
    ownLandingThatNeverYields('doc');

    for (let attempt = 0; attempt < 25; attempt += 1) {
      expect(runScrollNavigation('doc', 'deep-link', () => {})).toBe(false);
    }

    expect(declinedNavigations()).toHaveLength(1);
  });

  test('a second seam refused in the same window is recorded separately', () => {
    // Collapsing a ladder must not collapse two different dead clicks into one:
    // an outline row refused during a deep link is its own user-visible outcome.
    ownLandingThatNeverYields('doc');

    runScrollNavigation('doc', 'deep-link', () => {});
    runScrollNavigation('doc', 'outline', () => {});

    expect(declinedNavigations().map((p) => (p as { seam: string }).seam)).toEqual([
      'deep-link',
      'outline',
    ]);
  });

  test('a navigation that gets through re-arms the next refusal', () => {
    // The streak is what is being collapsed, and a successful claim ends it. A
    // later refusal is a new episode the reader felt separately.
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
    // Every other registry in the module is bounded by construction: the saved
    // scroll map caps, a suppression count self-deletes at zero, a landing
    // registration self-deletes when its set empties. A streak entry is cleared
    // only by a LATER navigation that succeeds on the same document, so one dead
    // click on a document the reader never returns to would hold an entry for
    // the rest of a session that walks hundreds of documents.
    const first = 'doc-0';
    ownLandingThatNeverYields(first);
    // Two seams on the one document, because an entry is a SET of seams: what an
    // eviction re-arms is every seam the dropped entry had marked, and a
    // single-seam streak cannot tell that apart from one extra mark.
    expect(runScrollNavigation(first, 'outline', () => {})).toBe(false);
    expect(runScrollNavigation(first, 'deep-link', () => {})).toBe(false);

    for (let i = 1; i <= MAX_TRACKED_DECLINE_DOCS; i += 1) {
      const later = `doc-${i}`;
      ownLandingThatNeverYields(later);
      runScrollNavigation(later, 'outline', () => {});
    }

    runScrollNavigation(first, 'outline', () => {});
    runScrollNavigation(first, 'deep-link', () => {});

    // The least recently refused streak was dropped, so both of the first
    // document's seams read as fresh episodes and mark again. Only a document
    // nobody has navigated since pays that — the polling case above still
    // collapses to one entry.
    expect(
      declinedNavigations().filter((props) => (props as { docName: string }).docName === first),
    ).toHaveLength(4);
  });

  test('the bare claim carries the same guarantee', () => {
    // The find/replace seam cannot scroll for itself: CodeMirror's search config
    // asks for a scroll EFFECT and dispatches it, so that seam claims the
    // scroller and hands the effect back. Same explicit navigation, same reader
    // that has to stand down, and no way to reach the wrapper form to get it.
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
    // The hold rides a bare timer with no owner: every other piece of state in
    // this module is dropped by some lifecycle, and a landing releases from its
    // own teardown. Left armed across a reset, that timer fires into whatever
    // counts exist by then and drops a hold it never took.
    runScrollNavigation('doc', 'outline', () => {});

    __resetScrollRestoreCoordination();
    const landing = acquireScrollRestoreSuppression('doc', 'landing');
    lapseOwnership();

    // A landing holds until its own teardown says otherwise. A navigation from
    // before the reset has no business ending it.
    expect(isScrollRestoreSuppressed('doc')).toBe(true);
    landing.release();
    expect(isScrollRestoreSuppressed('doc')).toBe(false);
  });
});
