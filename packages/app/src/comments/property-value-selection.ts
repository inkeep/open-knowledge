/**
 * The text a reviewer has highlighted inside a property's value.
 *
 * A property comment can be about the whole field or about one passage in it —
 * a `description` that runs several sentences deserves the same sentence-level
 * note a paragraph in the body gets. This reads that highlight from the value's
 * own form control.
 *
 * Read from `selectionStart` / `selectionEnd` rather than `window.getSelection`
 * because the value widgets are `<textarea>` / `<input>`, whose internal
 * selection the document Selection API does not report.
 *
 * Captured on POINTER-DOWN, before the click lands. Clicking the comment button
 * blurs the field, and while browsers keep the offsets after blur, the field is
 * no longer `document.activeElement` — so reading later cannot tell "the user
 * highlighted this" from "some other control has focus".
 */

const TEXT_CONTROL = /^(TEXTAREA|INPUT)$/;

/** The value control a comment button belongs to — same property row, if any. */
function textControlInRow(trigger: HTMLElement): HTMLTextAreaElement | HTMLInputElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !TEXT_CONTROL.test(active.tagName)) return null;
  const row = trigger.closest('[data-testid="property-row"]');
  // Scoped to the row that owns the button: a highlight left in a DIFFERENT
  // property's field would otherwise be quoted onto this one, which is the
  // wrong-target failure the whole anchoring design exists to avoid.
  if (row === null || !row.contains(active)) return null;
  return active as HTMLTextAreaElement | HTMLInputElement;
}

/**
 * The highlighted text inside this row's value, or null when nothing is
 * highlighted — in which case the comment is about the property as a whole.
 */
export function capturePropertyValueSelection(trigger: HTMLElement): string | null {
  const control = textControlInRow(trigger);
  if (control === null) return null;
  const { selectionStart, selectionEnd } = control;
  if (selectionStart === null || selectionEnd === null || selectionStart === selectionEnd) {
    return null;
  }
  const quote = control.value.slice(selectionStart, selectionEnd).trim();
  // Whitespace-only is not a passage. Treating it as one would send an anchor
  // that matches everywhere in the value.
  return quote === '' ? null : quote;
}
