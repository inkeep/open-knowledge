/**
 * What counts as content in a reporter's bug-report note.
 *
 * Two processes answer this independently and must not drift: Electron main
 * decides whether a note is worth persisting at all, and the renderer decides
 * whether one yields a row title. When they disagree, the sidecar holds a note
 * the row refuses to title and a later retry puts it on the wire as the
 * reporter's words.
 *
 * They share the primitives rather than one predicate, because they need
 * different things from the same rule: main needs the yes-or-no
 * (`isBlankNoteContent`), while the renderer needs the normalized string it is
 * about to paint (`stripInvisibleCharacters`, `clampToCodeUnits`). What must
 * stay identical is the notion of a character that does not count, which lives
 * here once.
 */

/**
 * Zero-width and bidi-control characters: present in a string, absent from the
 * screen. `String.prototype.trim` does not remove them, so a note made only of
 * these is neither empty nor visible.
 */
const INVISIBLE_CHARACTERS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/**
 * The value with every invisible character removed.
 *
 * A reader normalizes with this before deciding anything positional. A leading
 * zero-width space is not whitespace and does not trim, so a title derivation
 * that only trims would fail to see a `#` sitting one invisible character in
 * and would paint the marker the strip exists to remove.
 */
export function stripInvisibleCharacters(value: string): string {
  return value.replace(INVISIBLE_CHARACTERS, '');
}

/**
 * `value` with every ASCII control character mapped to a single space.
 *
 * Mapped, never deleted: a tab is a control character, and deleting it joins
 * the words either side of it. A NUL is the sharper case — invisible on screen
 * but enough to break exact text matching downstream, and the value comes off
 * disk from an open format, so its cleanliness cannot be assumed.
 */
export function mapControlCharactersToSpace(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point; this is the one place that decides what a control character is.
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ');
}

/**
 * True when the value has no character a reader could actually see.
 *
 * Control characters count as invisible here even though they are not in the
 * zero-width set, because the renderer maps them to spaces before deciding a
 * line is empty. Leaving them out would put the two processes back in
 * disagreement over a note of nothing but C0 controls.
 */
export function isBlankNoteContent(value: string): boolean {
  return mapControlCharactersToSpace(stripInvisibleCharacters(value)).trim() === '';
}

/**
 * `value` cut to at most `maxCodeUnits`, never leaving half an astral
 * character behind.
 *
 * Counts UTF-16 code units because that is what `String.prototype.length`
 * reports, and every ceiling in this feature is expressed in the same unit.
 * Slicing by code points instead would satisfy the eye and break the ceiling: a
 * cap of N code points can be 2N code units, which a length check downstream
 * would reject. A bare slice can land between the halves of a surrogate pair,
 * storing a lone surrogate that YAML round-trips happily and a renderer paints
 * as a replacement character, so drop a trailing high surrogate when the cut
 * lands on one.
 */
export function clampToCodeUnits(value: string, maxCodeUnits: number): string {
  if (value.length <= maxCodeUnits) return value;
  const clamped = value.slice(0, maxCodeUnits);
  const lastUnit = clamped.charCodeAt(clamped.length - 1);
  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? clamped.slice(0, -1) : clamped;
}
