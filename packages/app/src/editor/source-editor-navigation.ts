/**
 * Per-document pending-navigation stores: a durable "flip mode, then land here"
 * record that survives the mode swap and the target editor's (possibly lazy)
 * mount. Two stores, one per destination view — source-destined intents replay
 * when the CodeMirror view activates, WYSIWYG-destined intents when the TipTap
 * view activates. Both are in-memory, doc-scoped, consume-once, and expire on a
 * shared horizon so a much-later mode switch never replays a stale target.
 *
 * The cross-mode `selection-offset` kind additionally carries a relative-position
 * pin over the target's `Y.Text('source')` range. Y.Text is the document's
 * truth, so both directions land off the source ordinal and a single pin type
 * serves both stores. The pin lets a queued landing follow content that remote
 * peers move (or delete) during the capture-to-dispatch window instead of
 * indexing a frozen offset.
 */

import * as Y from 'yjs';
import type { OutlineNavDetail } from '@/components/OutlinePanel';
import type { LintNavDetail } from '@/components/ProblemsPanel';
import type { RawMdxNavDetail } from '@/editor/extensions/raw-mdx-nav-event';
import type { EditorModeValue } from '@/editor/use-editor-mode';
import type { BlockAnchor } from './mode-switch-position-resolver';

/**
 * A relative-position pin over a top-level block's `Y.Text('source')` range.
 * Pinning both ends (rather than a single offset) lets resolution distinguish
 * "the target moved" from "the target was deleted": a remote edit before the
 * block shifts both ends together, while deleting the block collapses them.
 */
export interface NavigationPin {
  start: Y.RelativePosition;
  end: Y.RelativePosition;
}

/**
 * A queued cross-mode landing: a resolver block anchor plus an optional pin. The
 * anchor's ordinal is the primary key; the pin, when present, upgrades a stale
 * capture-time offset to a live one at dispatch. Absent pin means no collab
 * tracking is available and the landing rides the ordinal alone.
 *
 * `intent` distinguishes the two landing behaviors that share this machinery: a
 * position-preserving toggle (scroll-only, non-interfering) versus an explicit
 * jump (centered, caret placed, highlighted). Absent means toggle — the
 * pre-existing behavior — so a plain toggle need not spell it out.
 */
export interface SelectionOffsetNavigation {
  kind: 'selection-offset';
  intent?: 'toggle' | 'jump';
  anchor: BlockAnchor;
  pin?: NavigationPin;
}

/** Navigation intents queued for the source view (frontmatter + body). */
type PendingSourceNavigation =
  | { kind: 'outline'; detail: OutlineNavDetail }
  | { kind: 'raw-mdx'; detail: RawMdxNavDetail }
  | { kind: 'lint'; detail: LintNavDetail }
  | SelectionOffsetNavigation;

/** Navigation intents queued for the WYSIWYG view. */
type PendingWysiwygNavigation = SelectionOffsetNavigation;

/**
 * Discard-at-consume horizon. The replay effect fires on every source-mode
 * activation, not only the first mount after a click — so an intent banked
 * while the doc sat in WYSIWYG must expire, or a much-later mode switch would
 * jump the cursor to stale coordinates.
 */
const PENDING_NAVIGATION_TTL_MS = 30_000;

interface PendingNavigationEntry<T> {
  navigation: T;
  rememberedAt: number;
}

interface PendingNavigationStore<T> {
  remember(docName: string, navigation: T): void;
  peek(docName: string): T | null;
  consume(docName: string): T | null;
  clear(docName: string): void;
  clearForTest(): void;
}

function createPendingNavigationStore<T>(): PendingNavigationStore<T> {
  const entries = new Map<string, PendingNavigationEntry<T>>();
  const live = (entry: PendingNavigationEntry<T> | undefined): T | null => {
    if (!entry) return null;
    return Date.now() - entry.rememberedAt > PENDING_NAVIGATION_TTL_MS ? null : entry.navigation;
  };
  return {
    remember(docName, navigation) {
      entries.set(docName, { navigation, rememberedAt: Date.now() });
    },
    peek(docName) {
      return live(entries.get(docName));
    },
    consume(docName) {
      const entry = entries.get(docName);
      entries.delete(docName);
      return live(entry);
    },
    clear(docName) {
      entries.delete(docName);
    },
    clearForTest() {
      entries.clear();
    },
  };
}

const sourceNavigations = createPendingNavigationStore<PendingSourceNavigation>();
const wysiwygNavigations = createPendingNavigationStore<PendingWysiwygNavigation>();

export const rememberPendingSourceNavigation = sourceNavigations.remember;
export const peekPendingSourceNavigation = sourceNavigations.peek;
export const consumePendingSourceNavigation = sourceNavigations.consume;
export const clearPendingSourceNavigation = sourceNavigations.clear;
export const clearPendingSourceNavigationsForTest = sourceNavigations.clearForTest;

export const rememberPendingWysiwygNavigation = wysiwygNavigations.remember;
export const peekPendingWysiwygNavigation = wysiwygNavigations.peek;
export const consumePendingWysiwygNavigation = wysiwygNavigations.consume;
export const clearPendingWysiwygNavigation = wysiwygNavigations.clear;
export const clearPendingWysiwygNavigationsForTest = wysiwygNavigations.clearForTest;

/**
 * Clear the intent destined for the view being left. On a flip, the intent for
 * the view being entered lives in the other store, so this only discards a
 * lingering target that never got a chance to replay — it never stomps the
 * landing the flip just queued.
 */
export function clearPendingNavigationForExitedMode(
  docName: string,
  exitedMode: EditorModeValue,
): void {
  if (exitedMode === 'source') {
    clearPendingSourceNavigation(docName);
  } else {
    clearPendingWysiwygNavigation(docName);
  }
}

/**
 * Pin a block's `Y.Text('source')` char range so a queued landing can track it
 * across remote edits. Pure read of the current state — no mutation, no
 * transaction (`Y.createRelativePositionFromTypeIndex` only reads item ids).
 */
export function createNavigationPin(
  ytext: Y.Text,
  blockStart: number,
  blockEnd: number,
): NavigationPin {
  return {
    start: Y.createRelativePositionFromTypeIndex(ytext, blockStart),
    end: Y.createRelativePositionFromTypeIndex(ytext, blockEnd),
  };
}

/**
 * Resolve a pin against the current document, returning the live start offset of
 * the surviving target, or `null` when it can no longer be resolved. Null covers
 * both a structure that is entirely gone (Yjs cannot map the id) and a range that
 * has collapsed — the pinned block was deleted out from under the queued landing.
 * The caller falls back to the resolver's clamped grade in that case rather than
 * landing on whatever content shifted into the old offset. A pure read: no
 * mutation, no transaction.
 */
export function resolveNavigationPin(pin: NavigationPin, ydoc: Y.Doc): number | null {
  const start = Y.createAbsolutePositionFromRelativePosition(pin.start, ydoc);
  const end = Y.createAbsolutePositionFromRelativePosition(pin.end, ydoc);
  if (start === null || end === null) return null;
  if (end.index <= start.index) return null;
  return start.index;
}
