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
 *   - a ref-counted suppression registry that lets a landing become the single
 *     scroll writer for a document while its settle window is open,
 *   - the landing-owner registry and `runScrollNavigation`, the primitive every
 *     explicit navigation scrolls through so it PRE-EMPTS an in-flight landing
 *     instead of being erased by it.
 *
 * Keeping this state in one module — rather than duplicating it in the landing
 * controller — is what makes the reconciliation honest: both writers read and
 * write the same map, so a landing result persists through the container's
 * remount-survival restore, and a later restore reproduces the landing rather
 * than the pre-landing position.
 */

import { measureAnchor } from '@/components/scroll-restore';
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
 * Ref-counted set of documents whose scroll-restore is currently suppressed. A
 * landing acquires a handle for the whole of its settle window so the
 * container's two-stage restore stands down and the landing is the single
 * scroll writer. Ref-counting tolerates overlapping holders (a re-dispatch that
 * briefly overlaps its predecessor) without one release re-enabling the restore
 * while another landing is still open.
 */
const suppressedDocs = new Map<string, number>();

interface ScrollRestoreSuppressionHandle {
  release(): void;
}

export function acquireScrollRestoreSuppression(docName: string): ScrollRestoreSuppressionHandle {
  suppressedDocs.set(docName, (suppressedDocs.get(docName) ?? 0) + 1);
  let released = false;
  return {
    release() {
      if (released) return; // idempotent: a double release must not underflow the count
      released = true;
      const remaining = (suppressedDocs.get(docName) ?? 0) - 1;
      if (remaining > 0) suppressedDocs.set(docName, remaining);
      else suppressedDocs.delete(docName);
    },
  };
}

export function isScrollRestoreSuppressed(docName: string): boolean {
  return (suppressedDocs.get(docName) ?? 0) > 0;
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
 * Take the document's scroller for an explicit navigation, pre-empting every
 * landing that yields. Returns false when a landing that does not yield still
 * owns it, in which case the caller must not scroll — see `runScrollNavigation`,
 * which is the form to reach for. This bare form exists for the one seam that
 * cannot perform its own scroll: CodeMirror's `scrollToMatch` returns a scroll
 * effect for the search extension to dispatch rather than scrolling itself.
 */
export function claimScrollerForNavigation(docName: string): boolean {
  const owners = landingScrollOwners.get(docName);
  if (!owners) return true;
  for (const owner of owners) {
    if (!owner.yieldsToNavigation) return false;
  }
  // Snapshot first: `supersede` releases the registration, and a landing that
  // registers a successor while unwinding would otherwise be superseded in the
  // same pass by the navigation that had already claimed the scroller.
  const superseding = Array.from(owners);
  for (const owner of superseding) owner.supersede();
  return true;
}

/**
 * Run an explicit, user-initiated navigation's scroll — an outline or
 * Problems-panel row click, a find/replace match, a deep-link anchor.
 *
 * Every such navigation goes through here rather than reaching for
 * `scrollIntoView` directly, so the precedence against an in-flight landing is
 * enforced by this producer instead of by each writer remembering to ask. That
 * is the difference that matters: a writer that forgets to poll silently opts
 * out of the contract, which is how a landing came to erase the source-mode
 * Problems-row jump. Put the navigation's selection write inside `scroll` too —
 * caret and viewport should move together or not at all.
 *
 * Returns whether the navigation ran.
 */
export function runScrollNavigation(docName: string, scroll: () => void): boolean {
  if (!claimScrollerForNavigation(docName)) return false;
  scroll();
  return true;
}

/** Test-only: clear all coordination state between cases. */
export function __resetScrollRestoreCoordination(): void {
  docScrollState.clear();
  suppressedDocs.clear();
  landingScrollOwners.clear();
}
