/**
 * Clicking a commented property value opens its thread — the property twin of
 * the body's highlight click.
 *
 * The body gets this from ProseMirror: the highlight IS a decoration, so the
 * plugin hangs a `handleClick` on it and asks the view which position was hit.
 * A property value is a `<textarea>`, which has no decorations and no positions
 * — so the same gesture has to be assembled from what a form control does
 * offer: the caret offset it sets on click, matched against each thread's
 * passage in that control's value.
 *
 * The asymmetry this closes was not cosmetic. A commented passage in the body
 * says "there is a comment here, click it" and answers when you do; a commented
 * property value said nothing and ignored the click, so the only ways into the
 * thread were the margin marker and the panel card. Clicking the words is the
 * gesture people try first, and it was the one that did nothing.
 *
 * What still differs, and cannot be made to match here: the body's highlight
 * RESTS on the passage, while a value's can only be painted as the field's own
 * `::selection` (see `revealPropertyValueRange`) and clears the moment focus or
 * the caret moves. So a value carries no at-rest mark saying which words the
 * comment is on — the click works, but it is a click into text that does not
 * look clickable. Fixing that needs the control replaced, not this listener.
 */

import { type RefObject, useEffect } from 'react';
import { locateInValue } from './property-row-rect';
import { emitOpenThreadPopover, getThreads } from './store';
import type { CommentThread } from './types';

const ROW_SELECTOR = '[data-testid="property-row"]';

/**
 * Marks a value control as belonging to a thread, so the popover's outside-click
 * dismisser lets the click through the way it already does for a body highlight
 * and a rail marker.
 *
 * Without it, clicking a commented value while its own popover is open closes it
 * on `mousedown` and this listener reopens it on `click` — one gesture, two
 * renders, a visible flash. The body never had that problem because its
 * decoration carries the same attribute.
 *
 * Stamped just-in-time on `mousedown` rather than kept in sync with the store:
 * the answer depends on the control's CURRENT value (a passage the reader has
 * since typed over is no longer there), and the only moment it has to be right
 * is the one between the click starting and the dismisser reading it. An
 * attribute maintained ahead of time would be a second copy of a fact that
 * changes on every keystroke.
 *
 * Set from here rather than rendered by `FrontmatterRow`: that row is shared by
 * templates, skills, and folder cards, none of which have threads, and it is
 * kept free of this subsystem for the same reason the comment BUTTON arrives as
 * a slot.
 */
const THREAD_ATTR = 'data-comment-thread';

/** The row's own key — its last path step, which is what the DOM carries. */
function rowKeyOf(thread: CommentThread): string | null {
  if (thread.target.kind !== 'property') return null;
  const { key, path } = thread.target;
  return path.length === 0 ? key : String(path[path.length - 1]);
}

interface PlacedRange {
  threadId: string;
  start: number;
  end: number;
}

/**
 * Every open thread that has a range in this control's value.
 *
 * Rows are addressed by their own key, not the full path, so two objects can
 * each have a `name` row and both match here. The VALUE settles it: a thread
 * whose passage is not in this control's text has no range and drops out —
 * the same "let the value decide" rule `revealPropertyValueRange` follows when
 * it walks candidate rows.
 *
 * A whole-field thread (no anchor) covers the whole value, because the field IS
 * what it is about. That is the property analogue of a body comment spanning
 * its passage, not a special case.
 */
export function placeValueThreads(
  threads: readonly CommentThread[],
  rowKey: string,
  value: string,
): PlacedRange[] {
  const placed: PlacedRange[] = [];
  for (const thread of threads) {
    if (thread.status !== 'open') continue;
    if (rowKeyOf(thread) !== rowKey) continue;
    if (thread.anchor === null) {
      placed.push({ threadId: thread.id, start: 0, end: value.length });
      continue;
    }
    const range = locateInValue(value, thread.anchor.quote, thread.anchor.start, thread.anchor.end);
    if (range === null) continue;
    placed.push({ threadId: thread.id, start: range.start, end: range.end });
  }
  return placed;
}

/**
 * Which thread a caret at `offset` is inside. Narrowest wins, so clicking where
 * a passage comment sits inside a whole-field one opens the specific thread —
 * the same tie-break the body's `handleClick` applies to overlapping
 * decorations.
 *
 * Inclusive of both edges, like the body: a caret resting at the end of a
 * passage is still on it.
 */
export function threadAtValueOffset(
  threads: readonly CommentThread[],
  rowKey: string,
  value: string,
  offset: number,
): string | null {
  let hit: PlacedRange | null = null;
  for (const range of placeValueThreads(threads, rowKey, value)) {
    if (offset < range.start || offset > range.end) continue;
    if (hit === null || range.end - range.start < hit.end - hit.start) hit = range;
  }
  return hit?.threadId ?? null;
}

function valueControl(target: EventTarget | null): HTMLTextAreaElement | HTMLInputElement | null {
  if (!(target instanceof HTMLElement)) return null;
  if (!(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement))
    return null;
  return target.closest(ROW_SELECTOR) === null ? null : target;
}

function rowKeyFor(control: HTMLElement): string | null {
  return control.closest(ROW_SELECTOR)?.getAttribute('data-key') ?? null;
}

/**
 * The caret, or null when this control has no notion of one.
 *
 * `selectionStart` is spec'd to throw on input types that do not support
 * selection (`number`, `date`, `color`), and a numeric property row renders
 * exactly those — so this is a real path, not defensive noise.
 */
function caretOffset(control: HTMLTextAreaElement | HTMLInputElement): number | null {
  try {
    return control.selectionStart;
  } catch {
    return null;
  }
}

/** Every thread with a range in this control's value, or `[]`. */
function threadsOn(
  control: HTMLTextAreaElement | HTMLInputElement,
  docName: string,
): PlacedRange[] {
  const rowKey = rowKeyFor(control);
  if (rowKey === null) return [];
  return placeValueThreads(getThreads(docName), rowKey, control.value);
}

/**
 * Wire click-to-open for every commented value in one property panel.
 *
 * Scoped to the panel's own container, not `document`: hidden entries in the
 * editor pool keep their panels mounted, so a document-level listener would
 * answer clicks in a pane belonging to another doc's threads.
 */
export function usePropertyAnchorClick(
  containerRef: RefObject<HTMLElement | null>,
  docName: string,
): void {
  useEffect(() => {
    if (docName === '') return;
    const container = containerRef.current;
    if (container === null) return;

    // Capture phase, so this runs before the popover's own document-level
    // `mousedown` dismisser — capture descends to the target before bubbling
    // climbs back to `document`, and that ordering is the whole point.
    const onMouseDownCapture = (event: MouseEvent) => {
      const control = valueControl(event.target);
      if (control === null) return;
      const placed = threadsOn(control, docName);
      if (placed.length === 0) control.removeAttribute(THREAD_ATTR);
      else control.setAttribute(THREAD_ATTR, placed[0].threadId);
    };

    // The click itself is NOT consumed — no `preventDefault`, no `focus` call.
    // The caret lands where the reader aimed it and the popover opens beside
    // it, which is the body's bargain too: a commented passage stays ordinary
    // editable text rather than becoming a button.
    const onClick = (event: MouseEvent) => {
      const control = valueControl(event.target);
      if (control === null) return;
      const rowKey = rowKeyFor(control);
      if (rowKey === null) return;
      // Read after the browser has placed the caret — which is why this rides
      // `click` and not `mousedown`. A drag-select reports its anchor end, and
      // that is the character the reader started from.
      const offset = caretOffset(control);
      if (offset === null) return;
      const threadId = threadAtValueOffset(getThreads(docName), rowKey, control.value, offset);
      if (threadId !== null) emitOpenThreadPopover(threadId);
    };

    container.addEventListener('mousedown', onMouseDownCapture, true);
    container.addEventListener('click', onClick);
    return () => {
      container.removeEventListener('mousedown', onMouseDownCapture, true);
      container.removeEventListener('click', onClick);
    };
  }, [containerRef, docName]);
}
