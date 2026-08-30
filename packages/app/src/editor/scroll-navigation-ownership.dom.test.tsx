// @vitest-environment jsdom
/**
 * An explicit navigation is the document's single scroll writer while it lands —
 * including against the editor container's own scroll-restore loop.
 *
 * The loop is armed on document activation and defends the position the reader
 * was last at, re-applying it every animation frame until something stops it.
 * Four things can: the suppression probe, its wheel/touchstart/mousedown/keydown
 * listeners, its takeover test, and a ten-second backstop.
 *
 * Of those, only the takeover test is something a navigation trips by accident,
 * and only in one direction. It fires on a scrollTop INCREASE, which has no
 * browser-side explanation and is therefore safely attributable to someone else;
 * a DECREASE is indistinguishable from the browser's shrink-clamp against a
 * transient height, so the loop reads it as drift and corrects it. A navigation
 * to a heading ABOVE the reader's position is exactly that shape, and gets
 * erased frame after frame until the backstop expires — the row highlights, the
 * view does not move, and then the same click starts working. (The direction
 * heuristic itself is pinned in components/scroll-restore.test.ts; nothing here
 * substitutes for that.)
 *
 * Which leaves the suppression probe as the one stop condition a navigation can
 * reach deliberately, in either direction. `runScrollNavigation` is the producer
 * that reaches it, precisely so that no caller has to know the population of
 * scroll writers. These cases pin the whole of that promise for the whole of
 * that population: the outline rows in both editor modes, deep-link anchors, the
 * Problems-panel rows, raw-MDX navigation, find/replace matches.
 *
 * The probe is shared with readers that do NOT run every frame, so the last case
 * covers the interleaving that makes those two populations different: a
 * document re-activated while a navigation still holds gets one chance at a
 * restore, and standing that one chance down leaves the reader at the top of the
 * document rather than where they navigated to.
 *
 * Fidelity: the real `ScrollPreservingContainer`, its real restore loop, and the
 * real coordination primitives. jsdom computes no layout, so scroll geometry is
 * stubbed on the prototype the way the sibling suppression test does, and a
 * direct scrollTop write stands in for `scrollIntoView`. The loop only ever
 * observes the effect on scrollTop, so the stand-in is faithful to its inputs;
 * a real smooth-scroll animation and real content-visibility materialization
 * are above this rung.
 */

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
/** Where the restore loop believes the reader was — the position it defends. */
const RESTORED_TOP = 4000;
/** A heading ABOVE that position: the navigation the loop refuses to yield to. */
const BACKWARD_TARGET = 500;
/** A heading BELOW it: the direction the loop already reads as a takeover. */
const FORWARD_TARGET = 4500;
/** A downward-shaped move nobody claimed — the drift the loop exists to correct. */
const UNCLAIMED_DRIFT = 1200;
/** Generous ceiling on a navigation's hold, so the case does not encode the value. */
const OWNERSHIP_LAPSES_WITHIN_MS = 2_000;

const scrollTops = new WeakMap<HTMLElement, number>();
/**
 * The scroller's reach. Mutable so a case can make the content SHORTER than the
 * saved position: the restore then writes its target but never counts as landed,
 * which is the only state in which the loop reports its exit as an INCOMPLETE
 * restore. A restore that already landed and was then taken over is a healthy
 * one, so it reports the handover alone.
 */
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
  // Frames are faked alongside timers so a case can advance the restore loop and
  // outlive a navigation's hold with one call, whichever clock each rides on.
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

/** Let the restore loop take several turns, the way it does in the wild. */
function letTheRestoreLoopRun(): void {
  vi.advanceTimersByTime(100);
}

/** Outlive a navigation's hold on the scroller. */
function lapseNavigationOwnership(): void {
  vi.advanceTimersByTime(OWNERSHIP_LAPSES_WITHIN_MS);
}

/**
 * The position the restore loop's re-apply branch reported forcing the scroller
 * onto, or `undefined` when that branch never ran. Emitted by the loop itself,
 * at most once per restore session — so a case reads production code's own
 * account of what it did rather than inferring from a final scrollTop.
 */
function reappliedTarget(): unknown {
  return getCollector()
    ?.marks.toArray()
    .find((m) => m.name === 'ok/scroll-restore/phase2-success')?.properties?.target;
}

/**
 * How the loop attributed its own exit, or `undefined` when it did not report
 * one. The field an operator reads to tell "someone else took the scroller" from
 * "the restore never ran", so it has to name the writer that actually took it.
 */
function yieldedReason(): unknown {
  return getCollector()
    ?.marks.toArray()
    .find((m) => m.name === 'ok/scroll-restore/yielded')?.properties?.reason;
}

/**
 * The position the restore reported LANDING on in its synchronous first stage,
 * or `undefined` when it never landed. What lets a case establish that a restore
 * had already completed rather than assume it.
 */
function landedTarget(): unknown {
  return getCollector()
    ?.marks.toArray()
    .find((m) => m.name === 'ok/scroll-restore/phase1-success')?.properties?.target;
}

/**
 * The writer the loop named as having taken the scroller from it, or `undefined`
 * when it recorded no handover. Unlike `yieldedReason` this is not conditioned
 * on the restore having failed, because a named writer taking over is
 * attributable either way.
 */
function supersededHolder(): unknown {
  return getCollector()
    ?.marks.toArray()
    .find((m) => m.name === 'ok/scroll-restore/superseded')?.properties?.holder;
}

/**
 * Mount the container active for `DOC`, restoring to `from`.
 *
 * No precondition assertion: a re-activation is exactly the moment a restore may
 * legitimately be measured for NOT running, so the case has to be able to see a
 * scroller left at zero rather than throw on it.
 */
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
  // Stage 1 of the restore ran synchronously inside the layout effect; the
  // per-frame poll is now armed and defending this position.
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
    // The loop's re-apply branch names the position it forced. Silence here is
    // the loop reporting that it never took the scroller back.
    expect(reappliedTarget()).toBeUndefined();

    // And it exits for GOOD on the handover rather than pausing for the length
    // of the hold. A loop that only paused would resume against a baseline it
    // never updated, read the navigation as drift, and re-apply the
    // pre-navigation target the moment the hold lapsed — the same erasure,
    // later. That is the property that lets the hold be brief rather than
    // open-ended. Deterministic under fake timers: a loop that stood down has
    // already cancelled its frame and its backstop, so this advance is inert.
    lapseNavigationOwnership();
    letTheRestoreLoopRun();
    expect(scroller.scrollTop).toBe(BACKWARD_TARGET);
    expect(reappliedTarget()).toBeUndefined();
  });

  test('survives when it moves the reader DOWN the document', () => {
    // The other direction, and the direction that already worked. It does not
    // reach the loop's takeover test from here — the hold is taken before the
    // write, so the suppression probe wins the race whichever way the reader
    // moves — so what this pins is that the hold covers both directions, not
    // that the direction heuristic still works. That heuristic has its own
    // cases, in components/scroll-restore.test.ts.
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
    // A landing that is itself an explicit navigation does not yield: it has
    // already placed the caret, so pre-empting it halfway would split caret and
    // viewport.
    registerLandingScrollOwner(DOC, { yieldsToNavigation: false, supersede: () => {} });

    const ran = runScrollNavigation(DOC, 'outline', () => {
      scroller.scrollTop = BACKWARD_TARGET;
    });

    expect(ran).toBe(false);
    expect(scroller.scrollTop).toBe(RESTORED_TOP);

    // Nothing was navigated to, so the loop still owns the scroller and still
    // corrects drift on it. Standing it down here would cost the reader their
    // place on top of the click that did nothing.
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

    // Re-activating the document arms a fresh loop. A navigation that never let
    // go would leave this one standing down for a click that finished a session
    // ago, and the reader would silently lose scroll restore on this document
    // from then on.
    const reactivated = mountWithLiveRestore();
    reactivated.scrollTop = UNCLAIMED_DRIFT;
    letTheRestoreLoopRun();

    expect(reactivated.scrollTop).toBe(RESTORED_TOP);
    expect(reappliedTarget()).toBe(RESTORED_TOP);
  });

  test('a document re-activated INSIDE the hold still restores the reader', () => {
    // The interleaving the cases above step over: each of them lapses the hold
    // before it re-activates, which pins the after-the-window behavior and is
    // blind to the inside-the-window one.
    //
    // The activation restore is not the per-frame loop. It reads the flag ONCE,
    // inside a layout effect whose deps carry no signal that fires when a hold
    // lapses, so standing it down is a restore that never happens rather than
    // one that happens a moment later. And the pool hides an inactive Activity
    // with display:none, which zeroes scrollTop before any layout effect can
    // read it — so the skipped restore does not leave the reader where they
    // were, it leaves them at the top.
    const scroller = mountWithLiveRestore();
    runScrollNavigation(DOC, 'outline', () => {
      scroller.scrollTop = BACKWARD_TARGET;
    });
    letTheRestoreLoopRun();

    // Switch away and back. Deliberately WITHOUT lapsing the hold: the window is
    // wider than its constant suggests, since the deep-link ladder takes four
    // overlapping holds and a hidden desktop window throttles the release timer.
    cleanup();
    getCollector()?.reset();
    const reactivated = activate(BACKWARD_TARGET);

    // Where the reader navigated to, not the top of the document.
    expect(reactivated.scrollTop).toBe(BACKWARD_TARGET);
  });

  test('the loop reports WHO took the scroller, not a fixed holder', () => {
    // `reason` is how an operator reading a trace answers "why did scroll
    // restore stop here". Its siblings each name a real actor — the user, an
    // unattributed external move — and this branch is probed before the
    // takeover test, so it absorbs every navigation. Reported as a landing, it
    // sends the reader to the landing controller to look for a mode-switch mark
    // that was never emitted, for a stop whose cause was an outline click.
    stubScrollHeight = CONTENT_TOO_SHORT_TO_LAND;
    const scroller = mountWithLiveRestore();

    runScrollNavigation(DOC, 'outline', () => {
      scroller.scrollTop = BACKWARD_TARGET;
    });
    letTheRestoreLoopRun();

    expect(yieldedReason()).toBe('navigation');
  });

  test('and reports a landing as a landing', () => {
    // The same branch, the other holder — so the case above is pinning the value
    // that gets reported rather than a constant that happens to have changed.
    stubScrollHeight = CONTENT_TOO_SHORT_TO_LAND;
    const scroller = mountWithLiveRestore();

    acquireScrollRestoreSuppression(DOC, 'landing');
    scroller.scrollTop = BACKWARD_TARGET;
    letTheRestoreLoopRun();

    expect(yieldedReason()).toBe('landing');
  });

  test('reports the handover even when the restore had already landed', () => {
    // The two cases above have to starve the restore of content to hear it
    // speak, because `yielded` is gated on a restore that never landed. That
    // gate is silent for the common shape: a restore that landed and is
    // re-applying its target frame after frame is exactly what a backward
    // navigation collides with. Silent, the last thing such a session records
    // is a phase-success — so a restore cut short by a named writer reads the
    // same as one that ran undisturbed. The reasoning for saying it in a
    // separate mark lives at the emission site.
    const scroller = mountWithLiveRestore();
    expect(landedTarget()).toBe(RESTORED_TOP);

    runScrollNavigation(DOC, 'outline', () => {
      scroller.scrollTop = BACKWARD_TARGET;
    });
    letTheRestoreLoopRun();

    expect(supersededHolder()).toBe('navigation');
    // Said in its own mark rather than by widening `yielded`, which means a
    // restore that did not complete. This one completed before the navigation
    // arrived, and counting it as incomplete would trade one attribution error
    // for another.
    expect(yieldedReason()).toBeUndefined();
  });

  test('and names a landing handover the same way', () => {
    // The other holder through the same branch, so the case above pins the value
    // being reported rather than a constant that happens to match it.
    const scroller = mountWithLiveRestore();

    acquireScrollRestoreSuppression(DOC, 'landing');
    scroller.scrollTop = BACKWARD_TARGET;
    letTheRestoreLoopRun();

    expect(supersededHolder()).toBe('landing');
  });

  test('a document re-activated inside a LANDING still stands down', () => {
    // The other half of the same distinction, and the reason the activation
    // restore reads the holder rather than ignoring the flag outright: a landing
    // is still placing a position, and will write one. Standing down for it
    // keeps a single writer; standing down for a navigation loses the position
    // outright.
    acquireScrollRestoreSuppression(DOC, 'landing');

    const reactivated = activate(RESTORED_TOP);

    expect(reactivated.scrollTop).toBe(0);
  });
});
