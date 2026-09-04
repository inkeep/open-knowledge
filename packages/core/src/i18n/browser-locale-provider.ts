import { type Bcp47Tag, toBcp47Tags } from './bcp47.ts';

export interface NavigatorLanguages {
  readonly languages?: readonly string[];
  readonly language?: string;
}

export function readBrowserLanguages(source?: NavigatorLanguages): readonly Bcp47Tag[] {
  const browser = source ?? (typeof navigator === 'undefined' ? undefined : navigator);
  if (browser === undefined) return [];
  if (browser.languages !== undefined && browser.languages.length > 0) {
    return toBcp47Tags(browser.languages);
  }
  if (browser.language !== undefined) return toBcp47Tags([browser.language]);
  return [];
}
