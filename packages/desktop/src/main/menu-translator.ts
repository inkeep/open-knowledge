/**
 * The translation seam the native menu builders take. Kept deliberately tiny
 * and Lingui-free so `menu.ts`, `spellcheck-menu.ts` and `asset-menu.ts` stay
 * cheap pure modules that a unit test can load without a catalog, an Electron
 * runtime, or an i18n instance.
 *
 * A builder that receives no translator falls back to `translateEnglish`, so
 * `buildMenuTemplate(deps)` returns the same English labels it always did.
 * That is what keeps the template tests (which look items up by exact English
 * label) and the packaged smoke tests honest without teaching either about
 * locales.
 *
 * The catalog-backed implementation lives in `main-i18n.ts` — it is the one
 * module that pulls in `@lingui/core`, and only the boot path wires it.
 */

/**
 * Render a menu string. `message` is the English source exactly as it appears
 * in the compiled catalog, so the implementation can hash it to a message id;
 * `values` fills the ICU placeholders that source declares.
 */
export type MenuTranslator = (message: string, values?: Record<string, string>) => string;

/**
 * Substitute `{name}` placeholders from `values`, leaving anything unmatched
 * alone. Enough for the English path, which never needs plurals or selects —
 * the four placeholder-bearing menu strings each interpolate one plain noun.
 */
export function translateEnglish(message: string, values?: Record<string, string>): string {
  if (values === undefined) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}
