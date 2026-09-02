export type Bcp47Tag = string & { readonly __brand: 'Bcp47Tag' };

type Assert<T extends true> = T;

type _RawStringIsNotABcp47Tag = Assert<string extends Bcp47Tag ? false : true>;

export function asBcp47Tag(value: string): Bcp47Tag | null {
  try {
    const canonical = Intl.getCanonicalLocales(value)[0];
    return canonical === undefined ? null : (canonical as Bcp47Tag);
  } catch {
    return null;
  }
}

export function toBcp47Tags(values: readonly string[]): readonly Bcp47Tag[] {
  const tags: Bcp47Tag[] = [];
  for (const value of values) {
    const tag = asBcp47Tag(value);
    if (tag !== null) tags.push(tag);
  }
  return tags;
}

export function toLanguageScript(tag: string): string | null {
  try {
    const canonical = Intl.getCanonicalLocales(tag)[0];
    if (canonical === undefined) return null;
    const maximized = new Intl.Locale(canonical).maximize();
    if (!maximized.language || !maximized.script) return null;
    return `${maximized.language}-${maximized.script}`;
  } catch {
    return null;
  }
}
