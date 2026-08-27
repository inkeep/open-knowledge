/**
 * Coordination surface for the per-document scroll-restore layer.
 *
 * The scroll bookkeeping that `ScrollPreservingContainer` (EditorActivityPool)
 * uses to save and restore a document's scroll position lives here as the
 * single source of truth, so a second scroll writer — a mode-switch landing —
 * can reconcile with it instead of racing it:
 *
 *   - the per-document saved-position map — a body-relative offset for a
 *     same-mode restore, the mode it was captured in, and a scroll fraction for
 *     a cross-mode proportional floor — plus its reader and writers,
 *   - a ref-counted suppression registry that lets a landing — or an explicit
 *     navigation — become the single scroll writer for a document while its
 *     window is open, and that names WHICH of the two holds it, because a
 *     reader with only one chance to write has to tell them apart,
 *   - the landing-owner registry, and the navigation primitives every explicit
 *     navigation scrolls through so it stands BOTH of those writers down
 *     instead of being erased by whichever one it did not tell.
 *
 * Keeping this state in one module — rather than duplicating it in the landing
 * controller — is what makes the reconciliation honest: both writers read and
 * write the same map, so a landing result persists through the container's
 * remount-survival restore, and a later restore reproduces the landing rather
 * than the pre-landing position.
 */

import { measureAnchor } from '@/components/scroll-restore';
import { mark } from '@/lib/perf/mark';
import type { EditorModeValue } from './use-editor-mode';

/**
 * A document's saved scroll position, along with the editor mode it was captured
 * in and a whole-range fraction. The mode makes a restore honest: the offset
 * only maps back to the same body content in the SAME mode, because each mode's
 * geometry is different. When the document is re-activated in a different mode
 * than it was left in, the precise offset would drive the scroller against the
 * other mode's layout — so the restore falls back to `fraction` (how far through
 * the scrollable range the user was) for a proportional floor instead.
 */
export interface DocScrollState {
  /** Body-relative offset (scrollTop minus above-body anchor height). */
  offset: number;
  /** The editor mode this position was captured in. */
  mode: EditorModeValue;
  /** scrollTop as a fraction [0,1] of the scrollable range at capture time. */
  fraction: number;
}

/**
 * scrollTop expressed as a fraction of the container's scrollable range, clamped
 * to `[0,1]`. Zero when the content does not overflow (nothing to be a fraction
 * of). The mode-independent floor a cross-mode restore lands on.
 */
export function scrollFraction(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const max = scrollHeight - clientHeight;
  if (max <= 0) return 0;
  return Math.max(0, Math.min(1, scrollTop / max));
}

/**
 * Per-document saved scroll state keyed by `docName`. Two reasons it lives at
 * module scope, not in a per-instance ref:
 *   1. Survives the editor's REMOUNT on navigate-back — the fresh
 *      ScrollPreservingContainer instance re-reads the same value instead of
 *      losing it (the per-instance ref was the bug: a remount dropped it and
 *      then re-captured churn from the resize).
 *   2. The offset is body-relative — a Properties-panel height change
 *      (collapse/expand, even globally on another doc) never invalidates it,
 *      because it is measured from the top of the body, not the top of the
 *      scroller.
 * Same-mode restore = currentAnchor + storedOffset, so it always lands on the
 * same body content regardless of the panel's current height.
 *
 * Entries are deliberately kept PAST Activity eviction (so revisiting a
 * pooled-out doc still restores scroll), so there is no per-eviction cleanup —
 * but to keep a very long session from growing the map without bound,
 * `rememberDocScrollState` caps it at `MAX_TRACKED_DOC_SCROLL`, dropping the
 * least-recently-written entry (re-insert-on-write makes the order LRU).
 */
export const MAX_TRACKED_DOC_SCROLL = 256;
const docScrollState = new Map<string, DocScrollState>();

export function rememberDocScrollState(docName: string, state: DocScrollState): void {
  docScrollState.delete(docName); // re-insert last → LRU order for eviction
  docScrollState.set(docName, state);
  if (docScrollState.size > MAX_TRACKED_DOC_SCROLL) {
    const oldest = docScrollState.keys().next().value;
    if (oldest !== undefined) docScrollState.delete(oldest);
  }
}

/** The persisted scroll state for a document, or undefined if none. */
export function getDocScrollState(docName: string): DocScrollState | undefined {
  return docScrollState.get(docName);
}

/**
 * Attribute marking the zero-height body-top anchor inside a scroll container.
 * The container's own restore effect holds a React ref to the same node; this
 * marker lets a landing find it from a bare container element it did not mount.
 */
export const BODY_ANCHOR_ATTR = 'data-ok-body-anchor';

/**
 * Persist a landing at `targetScrollTop` so a later scroll restore for the same
 * document reproduces it. Stored body-relative (targetScrollTop minus the
 * current above-body anchor height), so it survives the editor's remount and
 * tracks a Properties-panel height change the same way a captured user scroll
 * does — writing a raw scrollTop alone would survive neither. Falls back to the
 * raw target when the container has no resolvable body anchor (a scroller
 * without the dual-editor body, e.g. a recovery panel), matching the restore's
 * own absent-anchor fallback. `mode` is the mode the landing lands in, so a later
 * re-activation in a different mode floors instead of driving this offset.
 *
 * An anchor that is mounted but generates no layout boxes takes the same raw
 * fallback rather than its zero rect: a viewport-origin measurement here would
 * write a self-amplifying offset into the very map the restore loop reads, the
 * corruption class `measureAnchor` exists to make unrepresentable. A landing
 * records only after its final snap to settled geometry, so this is a
 * degenerate path, not the normal one.
 */
export function writeLandingResult(params: {
  docName: string;
  container: HTMLElement;
  targetScrollTop: number;
  mode: EditorModeValue;
  anchor?: HTMLElement | null;
}): void {
  const anchor =
    params.anchor ?? params.container.querySelector<HTMLElement>(`[${BODY_ANCHOR_ATTR}]`);
  const measurement = measureAnchor(params.container, anchor);
  const anchorPos = measurement.kind === 'measured' ? measurement.contentPos : 0;
  rememberDocScrollState(params.docName, {
    offset: params.targetScrollTop - anchorPos,
    mode: params.mode,
    fraction: scrollFraction(
      params.targetScrollTop,
      params.container.scrollHeight,
      params.container.clientHeight,
    ),
  });
}

/**
 * The kind of writer holding a document's scroller, and the reason this
 * registry answers more than yes/no.
 *
 * A LANDING is PLACING a position: it has a target, it re-verifies that target
 * on every layout signal, and it writes the result into the saved-position map
 * when it settles. Standing down for one defers to a writer that is going to
 * leave the document somewhere deliberate.
 *
 * A NAVIGATION has ALREADY written its position and is only defending it for a
 * brief hold. Nothing further is coming from it.
 *
 * That difference decides what a reader which runs ONCE should do. A per-frame
 * reader stands down for either and looks again next frame. A one-shot reader —
 * the container's activation restore, the cached editor's warm-reparent write —
 * has no next frame: it writes now or it never writes at all. Deferring to a
 * landing is safe there, because the landing supplies a position of its own.
 * Deferring to a navigation is not: nobody else will write one, and both of
 * those surfaces start from a scroller sitting at zero.
 */
export type ScrollHolder = 'landing' | 'navigation';

/**
 * Per-document suppression counts, kept PER HOLDER KIND rather than as one
 * total.
 *
 * Ref-counting is what tolerates overlapping holders (a re-dispatch that briefly
 * overlaps its predecessor; a navigation taken across a landing handover)
 * without one release re-enabling the restore while another holder is still
 * open. Counting each kind separately is what keeps "which kind holds it"
 * correct under those overlaps whatever the RELEASE ORDER turns out to be: a
 * single last-writer-wins field would report `navigation` the moment a
 * navigation released out from under a landing that still holds.
 */
interface SuppressionCounts {
  landing: number;
  navigation: number;
}

const suppressedDocs = new Map<string, SuppressionCounts>();

/**
 * Bumped by `__resetScrollRestoreCoordination`. A handle issued before a reset
 * refers to counts that no longer exist, so releasing it afterwards has to be
 * inert rather than decrementing whatever a later holder put in their place.
 */
let registryGeneration = 0;

interface ScrollRestoreSuppressionHandle {
  release(): void;
}

export function acquireScrollRestoreSuppression(
  docName: string,
  holder: ScrollHolder,
): ScrollRestoreSuppressionHandle {
  const counts = suppressedDocs.get(docName) ?? { landing: 0, navigation: 0 };
  counts[holder] += 1;
  suppressedDocs.set(docName, counts);
  const generation = registryGeneration;
  let released = false;
  return {
    release() {
      if (released) return; // idempotent: a double release must not underflow the count
      released = true;
      if (generation !== registryGeneration) return; // the counts this held were discarded
      const live = suppressedDocs.get(docName);
      if (!live) return;
      live[holder] = Math.max(0, live[holder] - 1);
      if (live.landing === 0 && live.navigation === 0) suppressedDocs.delete(docName);
    },
  };
}

/**
 * Which kind of writer holds this document's scroller, or null when none does.
 *
 * A landing outranks a navigation while both hold, because it is the one still
 * placing a position: a one-shot reader that stands down for it ends up with a
 * deliberate position written by someone, which is the property it stood down
 * to preserve in the first place.
 */
export function scrollSuppressionHolder(docName: string): ScrollHolder | null {
  const counts = suppressedDocs.get(docName);
  if (!counts) return null;
  if (counts.landing > 0) return 'landing';
  if (counts.navigation > 0) return 'navigation';
  return null;
}

/**
 * Whether ANY writer holds this document's scroller. The predicate for a reader
 * that runs every frame: it stands down for whoever holds it and looks again on
 * the next one, so it never needs to know which. A reader that gets a single
 * chance wants `scrollSuppressionHolder` instead.
 */
export function isScrollRestoreSuppressed(docName: string): boolean {
  return scrollSuppressionHolder(docName) !== null;
}

/**
 * A landing that currently owns a document's scroller.
 *
 * Suppression alone cannot express the relationship between a landing and an
 * explicit navigation. A landing verifies its target on every layout signal and
 * treats any scrollTop it did not write as drift, so a navigation that merely
 * scrolls during the settle window is measured as drift and reset a few
 * milliseconds later — and then the erased position is persisted by the landing.
 * Standing the navigation down instead is no better: the caret still moves, so
 * the user gets a dead click on a document that quietly agrees with them. The
 * resolution is pre-emption, which needs a handle on the landing itself.
 */
export interface LandingScrollOwner {
  /**
   * Whether an explicit navigation supersedes this landing. A position-
   * preserving toggle yields: the place the user just asked for outranks the
   * place they were. A landing that is ITSELF an explicit navigation (a jump)
   * does not — it has already placed the caret, so pre-empting it halfway would
   * strand caret and viewport in different places, the very split this contract
   * exists to prevent.
   */
  yieldsToNavigation: boolean;
  /** Terminate the landing and release the scroller. */
  supersede(): void;
}

/**
 * Landings holding a document's scroller. A set rather than a single entry
 * because holders can briefly overlap (a re-dispatch that starts before its
 * predecessor is cancelled), the same overlap the suppression count tolerates.
 */
const landingScrollOwners = new Map<string, Set<LandingScrollOwner>>();

export function registerLandingScrollOwner(
  docName: string,
  owner: LandingScrollOwner,
): { release(): void } {
  const owners = landingScrollOwners.get(docName) ?? new Set<LandingScrollOwner>();
  owners.add(owner);
  landingScrollOwners.set(docName, owners);
  return {
    release() {
      const live = landingScrollOwners.get(docName);
      if (!live) return;
      live.delete(owner);
      if (live.size === 0) landingScrollOwners.delete(docName);
    },
  };
}

/**
 * How long an explicit navigation keeps the scroller after claiming it.
 *
 * Long enough for the scroll-restore loop to see the flag on its next frame and
 * stand down (it exits for good at that point), short enough that the flag's
 * softer readers — the agent-follow scroll and the composer's bottom pin — are
 * barely affected. A hold scoped to the caller's synchronous write would be gone
 * before any of them looked, which is indistinguishable from never having held
 * it.
 *
 * This is the length of ONE hold, not of every window a seam can produce. A seam
 * that re-claims on a cadence shorter than this chains them into one unbroken
 * stretch. The deep-link follow-up ladder and the comment-reveal settle ticker
 * each run to a bound of their own, so their chains end without the reader doing
 * anything. The find seam has none: `scrollToMatch` re-claims on every search
 * entry point, so a reader stepping through matches holds the scroller for as
 * long as they keep stepping, plus one more window. Size a change to this
 * constant against the chained window a seam actually produces, not against
 * 600ms.
 *
 * The one-shot readers that start from a scroller sitting at zero are NOT on the
 * softer-readers list, and cannot be traded against by shortening this: they gate
 * on a `'landing'` holder, so no value of this constant reaches them. The caret
 * reveal is the one one-shot reader deliberately left on the plain boolean — it
 * starts from wherever the reader already is, so dropping it costs a caret
 * scroll rather than stranding anyone at the top, and revealing a caret would
 * fight the place the user just asked for.
 */
const NAVIGATION_OWNERSHIP_MS = 600;

/**
 * Which seam asked for a navigation.
 *
 * Carried on the refusal mark so a refused navigation is attributable to the
 * click that produced it, which matters because the seams differ in what a
 * refusal COSTS. `outline`, `raw-mdx` and `find-match` drop the answer and have
 * no recovery, so a refusal there is a dead click. `deep-link`, `comment-reveal`
 * and `problems-row` consume the answer and try again, so a refusal there is a
 * delay.
 */
export type NavigationSeam =
  | 'outline'
  | 'deep-link'
  | 'problems-row'
  | 'raw-mdx'
  | 'find-match'
  | 'comment-reveal';

/**
 * A navigation the scroller refused to hand over.
 *
 * The seams that drop the claim's answer treat it as an action rather than a
 * question, so for them the refusal is an outcome nobody downstream can observe:
 * a row highlights, the caret may already have moved, and the view does not.
 * That is why the mark carries the seam — the same event means a dead click at
 * one call site and a late one at another. `NavigationSeam` is where the split
 * is written down.
 */
const NAVIGATION_DECLINED_MARK = 'ok/scroll-nav/declined';

/**
 * Seams whose refusal has already been marked, per document, since the last
 * navigation that got through.
 *
 * Two of the consuming seams poll: the comment reveal re-runs its attempt on an
 * 80ms ticker for ten seconds, and the deep-link ladder retries a hundred times
 * at 100ms. Marking every tick would emit a hundred byte-identical entries, and
 * both of the places a mark lands are worse for it.
 *
 * In a PRODUCTION build a mark is one `performance.measure` call. The user
 * timing buffer it appends to has no size limit and nothing in this app ever
 * calls `clearMeasures`, so the flood is buffer growth the session never gets
 * back — a cost that is paid whether or not anyone is looking. In a DEV build it
 * also fills the trace ring, evicting the surrounding scroll-restore and
 * mode-switch marks, which are the only way to identify WHICH landing refused:
 * there the flood destroys the very attribution the mark exists for.
 *
 * So the mark counts EPISODES, not attempts: one per unbroken run of refusals
 * per seam, re-armed by the next navigation that succeeds on that document.
 */
const markedDeclines = new Map<string, Set<NavigationSeam>>();

/**
 * How many documents may carry a refusal streak at once.
 *
 * An entry is created by a refusal and cleared only by a LATER navigation that
 * succeeds on the same document, so a document that is clicked once, refused,
 * and never navigated again would hold one for the rest of the session. Capped
 * for the same reason `MAX_TRACKED_DOC_SCROLL` is, and far lower, because a
 * streak is only meaningful while the reader is still clicking around that
 * document. An entry is a SET of seams, so dropping the least recently refused
 * one re-arms every seam it had already marked — at most one extra mark per
 * seam — on a document nobody has navigated in a long time.
 */
export const MAX_TRACKED_DECLINE_DOCS = 32;

function shouldMarkDecline(docName: string, seam: NavigationSeam): boolean {
  const marked = markedDeclines.get(docName) ?? new Set<NavigationSeam>();
  markedDeclines.delete(docName); // re-insert last → LRU order for eviction
  markedDeclines.set(docName, marked);
  if (markedDeclines.size > MAX_TRACKED_DECLINE_DOCS) {
    const oldest = markedDeclines.keys().next().value;
    if (oldest !== undefined) markedDeclines.delete(oldest);
  }
  if (marked.has(seam)) return false;
  marked.add(seam);
  return true;
}

/**
 * Pending hold releases, so `__resetScrollRestoreCoordination` can revoke them.
 *
 * Every other piece of state in this module is revocable by some lifecycle — a
 * landing releases its suppression and its owner registration from `teardown`.
 * A hold's release rides a bare timer with no owner, so without this set a timer
 * armed before a reset would fire afterwards against unrelated counts.
 */
const navigationHoldTimers = new Set<ReturnType<typeof setTimeout>>();

/** Stand the document's scroll writers down for a navigation, briefly. */
function holdScrollerForNavigation(docName: string): void {
  const suppression = acquireScrollRestoreSuppression(docName, 'navigation');
  const timer = setTimeout(() => {
    navigationHoldTimers.delete(timer);
    suppression.release();
  }, NAVIGATION_OWNERSHIP_MS);
  navigationHoldTimers.add(timer);
}

/**
 * Take the document's scroller for an explicit navigation: stand its other
 * scroll writers down and pre-empt every landing that yields. Returns false when
 * a landing that does not yield still owns it, in which case the caller must not
 * scroll — see `runScrollNavigation`, which is the form to reach for. This bare
 * form exists for the one seam that cannot perform its own scroll: CodeMirror's
 * `scrollToMatch` returns a scroll effect for the search extension to dispatch
 * rather than scrolling itself.
 *
 * BOTH writers are told, because a caller cannot know which one it is about to
 * collide with. Landings are pre-empted through their registry; the pool's
 * scroll-restore loop is stood down through the suppression count it polls every
 * frame. Told only about the landing, that loop does NOT yield to a navigation
 * toward the TOP of the document: its takeover test is directional, and a
 * scrollTop decrease is indistinguishable from the browser's shrink-clamp, so it
 * re-applies its own target over the navigation's, frame after frame, until its
 * ten-second backstop expires. That is why a heading above the current view did
 * nothing for click after click and then suddenly worked — the clicks were not
 * accumulating, the backstop was running out.
 *
 * What the hold deliberately does NOT stand down are the readers that get a
 * single chance to write: the container's activation restore and the cached
 * editor's warm-reparent write. Those gate on a `'landing'` holder, because a
 * landing supplies a position of its own while a navigation has already supplied
 * one — a one-shot reader that deferred to this hold would drop the position
 * rather than defer it, and both of those surfaces start from a scroller at
 * zero. See `ScrollHolder` for the whole of that distinction.
 *
 * The hold is taken BEFORE the landings are superseded: `supersede` unwinds a
 * landing, releasing its own suppression handle and then handing control to its
 * outcome callback, so taking ours first keeps the count from dipping to zero
 * across the handover. A refused claim takes no hold at all — nothing scrolled,
 * so there is nothing to defend, and suppressing anyway would cost the reader
 * their place on top of the click that did nothing.
 */
export function claimScrollerForNavigation(docName: string, seam: NavigationSeam): boolean {
  const owners = landingScrollOwners.get(docName);
  // Snapshot before anything unwinds: `supersede` releases the registration, and
  // a landing that registers a successor while unwinding would otherwise be
  // superseded in the same pass by the navigation that had already claimed the
  // scroller.
  const superseding = owners ? Array.from(owners) : [];
  for (const owner of superseding) {
    if (!owner.yieldsToNavigation) {
      if (shouldMarkDecline(docName, seam)) {
        mark(NAVIGATION_DECLINED_MARK, { docName, seam, ownerCount: superseding.length });
      }
      return false;
    }
  }
  // The scroller was available, so any refusal streak on this document is over
  // and the next one is a new episode worth marking.
  markedDeclines.delete(docName);
  holdScrollerForNavigation(docName);
  for (const owner of superseding) owner.supersede();
  return true;
}

/**
 * Run an explicit, user-initiated navigation's scroll — an outline or
 * Problems-panel row click, a find/replace match, a deep-link anchor.
 *
 * Every such navigation goes through here rather than reaching for
 * `scrollIntoView` directly, so the precedence against the document's other
 * scroll writers is enforced by this producer instead of by each writer
 * remembering to ask. That is the difference that matters: a writer that forgets
 * to poll silently opts out of the contract, which is how a landing came to
 * erase the source-mode Problems-row jump. Put the navigation's selection write
 * inside `scroll` too — caret and viewport should move together or not at all.
 *
 * The claim is taken before `scroll` runs and held past this call, because the
 * restore loop measures a frame later: a move it reads before the flag is drift
 * to correct rather than a takeover to respect.
 *
 * Returns whether the navigation ran.
 */
export function runScrollNavigation(
  docName: string,
  seam: NavigationSeam,
  scroll: () => void,
): boolean {
  if (!claimScrollerForNavigation(docName, seam)) return false;
  scroll();
  return true;
}

/** Test-only: clear all coordination state between cases. */
export function __resetScrollRestoreCoordination(): void {
  // Cancelled first, and the generation bumped last, so a hold armed by the
  // previous case can neither fire nor decrement a count belonging to the next.
  for (const timer of navigationHoldTimers) clearTimeout(timer);
  navigationHoldTimers.clear();
  markedDeclines.clear();
  docScrollState.clear();
  suppressedDocs.clear();
  landingScrollOwners.clear();
  registryGeneration += 1;
}
