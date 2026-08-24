/**
 * Where a frontmatter row is on screen.
 *
 * A property comment has no ProseMirror position, which is why the rail cannot
 * ask the editor to place its marker. It can ask the DOM: the properties table
 * sits in the SAME scroll container as the editor body (the container also
 * holds the cover), so a row's viewport rect is directly
 * comparable to the `coordsAtPos` rects the body threads produce, and the two
 * kinds of marker can share one layout pass.
 *
 * Returns null when the row is not rendered — the properties disclosure is
 * collapsed, or the key was removed. Callers skip rather than guess a position;
 * a marker pinned to an arbitrary y is worse than an absent one.
 */

import { COMMENT_ACTIVE_FILL, COMMENT_HUE } from './anchor-layers';

/**
 * Marks the field whose selection is standing in for a comment highlight, so
 * `globals.css` can paint it the comment hue instead of the browser's ordinary
 * selection. Cleared on blur — once the reveal is over the field's ordinary
 * selection must look ordinary again.
 */
const REVEAL_ATTR = 'data-comment-reveal';

/** jsdom's preload lacks `CSS.escape`; keys are author-controlled, so escaping is required. */
function escapeAttr(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value;
}

export function findPropertyRow(key: string): HTMLElement | null {
  if (key === '') return null;
  return document.querySelector<HTMLElement>(
    `[data-testid="property-row"][data-key="${escapeAttr(key)}"]`,
  );
}

export function propertyRowRect(key: string): DOMRect | null {
  const row = findPropertyRow(key);
  if (row === null) return null;
  const rect = row.getBoundingClientRect();
  // A collapsed disclosure can leave the node mounted at zero height. That is
  // not a place to point at, so treat it as absent.
  return rect.height === 0 && rect.width === 0 ? null : rect;
}

/** Bring a property row into view — the property twin of scrolling to a passage. */
export function scrollPropertyRowIntoView(key: string): void {
  findPropertyRow(key)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/**
 * Show which words a value comment is on, by SELECTING them in the field.
 *
 * A body passage gets a persistent highlight because the document renders as
 * styled spans. A property value is a `<textarea>`, whose text no CSS can reach
 * — so the only highlight available is the browser's own selection, and this
 * paints it. Transient by nature: it clears when focus moves, which makes it a
 * reveal rather than a highlight, and is why the thread card and the rail marker
 * both call it on click rather than the panel drawing it at rest.
 *
 * Returns whether it found something to select, so callers can fall back to
 * merely scrolling the row.
 */
export function revealPropertyValueRange(args: {
  /** Top-level frontmatter key. */
  key: string;
  /** Steps into the value; its last step names the row that renders the field. */
  path: readonly (string | number)[];
  quote: string;
  /** Server-maintained offsets into the VALUE. A hint — verified before use. */
  start?: number;
  end?: number;
}): boolean {
  if (args.quote === '') return false;
  // Nested rows are keyed by their own child key, not the full path, so two
  // objects can each have a `name` row. Prefer rows matching the last step, then
  // fall back to every row — and let the value itself settle which one it is.
  const lastStep = args.path.length === 0 ? args.key : args.path[args.path.length - 1];
  const preferred = Array.from(
    document.querySelectorAll<HTMLElement>(
      `[data-testid="property-row"][data-key="${escapeAttr(String(lastStep))}"]`,
    ),
  );
  const all = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="property-row"]'));
  for (const row of [...preferred, ...all]) {
    const control = row.querySelector<HTMLTextAreaElement | HTMLInputElement>('textarea, input');
    if (control === null) continue;
    const range = locateInValue(control.value, args.quote, args.start, args.end);
    if (range === null) continue;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    control.focus();
    control.setSelectionRange(range.start, range.end);
    paintRevealSelection(control);
    return true;
  }
  return false;
}

/**
 * The stored offsets first, verified against the words; a search only if they no
 * longer hold. Same order the server's re-find uses, and for the same reason —
 * the position is a hint that is usually right and never trusted on its own.
 *
 * Exported because the click side has to agree with the reveal side about where
 * a passage sits: a click that opened a thread whose reveal then selected
 * different characters would be two answers to one question.
 */
export function locateInValue(
  value: string,
  quote: string,
  start?: number,
  end?: number,
): { start: number; end: number } | null {
  if (start !== undefined && end !== undefined && value.slice(start, end) === quote) {
    return { start, end };
  }
  const index = value.indexOf(quote);
  return index < 0 ? null : { start: index, end: index + quote.length };
}

/**
 * Colour this one selection like a comment highlight, and only while it stands
 * for one.
 *
 * `::selection` cannot be set inline, so the rule lives in `globals.css` and
 * reads a custom property the element carries — which is what keeps the colour
 * defined once, beside the decoration hue it matches.
 *
 * Scoped to the reveal because the attribute would otherwise repaint every
 * ordinary selection in that field: someone highlighting text to retype it
 * would see comment-blue and reasonably think they had hit a comment.
 */
function paintRevealSelection(control: HTMLTextAreaElement | HTMLInputElement): void {
  control.style.setProperty('--comment-reveal-fill', `rgba(${COMMENT_HUE},${COMMENT_ACTIVE_FILL})`);
  control.setAttribute(REVEAL_ATTR, 'true');
  const clear = () => {
    control.removeAttribute(REVEAL_ATTR);
    control.style.removeProperty('--comment-reveal-fill');
  };
  // Blur ends the reveal; so does any fresh selection the user makes themselves,
  // which is no longer the comment's range even when it overlaps it.
  control.addEventListener('blur', clear, { once: true });
  control.addEventListener('pointerdown', clear, { once: true });
  control.addEventListener('keydown', clear, { once: true });
}
