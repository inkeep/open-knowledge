import { type Bcp47Tag, toBcp47Tags } from './bcp47.ts';

/**
 * The slice of `Navigator` the language signal lives on.
 *
 * Structural, so the DOM and Node declarations of `Navigator` both satisfy it
 * and a test can describe a browser the runtime running the test does not have.
 * Both members are optional because this is a trust boundary: privacy modes and
 * embedded webviews do vary here, and Node defines its own `navigator` whose
 * shape is not ours to assume.
 */
export interface NavigatorLanguages {
  readonly languages?: readonly string[];
  readonly language?: string;
}

/**
 * Read the browser's ordered language preferences as canonical BCP 47.
 *
 * `navigator.languages` already speaks BCP 47, so unlike the Node provider this
 * one only has to canonicalize and drop what it cannot use. It falls back to the
 * singular `navigator.language` when the list is missing or empty, and reports
 * no signal at all outside a browser rather than inventing one — a runtime with
 * no browser has nothing to say about the user's interface language.
 */
export function readBrowserLanguages(source?: NavigatorLanguages): readonly Bcp47Tag[] {
  const browser = source ?? (typeof navigator === 'undefined' ? undefined : navigator);
  if (browser === undefined) return [];
  if (browser.languages !== undefined && browser.languages.length > 0) {
    return toBcp47Tags(browser.languages);
  }
  if (browser.language !== undefined) return toBcp47Tags([browser.language]);
  return [];
}
