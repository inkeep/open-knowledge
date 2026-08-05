/**
 * The interface locales OpenKnowledge enumerates, ordered by total speakers.
 *
 * Single source of truth. The config enum, the Lingui catalog list in
 * `packages/app/lingui.config.ts`, and the locale matcher all derive from this
 * tuple; a config value with no catalog behind it is a user choosing a language
 * and getting English, so the two lists are pinned equal by a test rather than
 * kept in sync by hand.
 *
 * Chinese is tagged by script, not by region. Region tags strand Simplified
 * readers in Singapore and Malaysia and Traditional readers in Hong Kong and
 * Macau; `zh-Hans` / `zh-Hant` serve every region correctly once a preference
 * tag is run through Unicode's likely-subtags maximization (`zh-HK` maximizes
 * to `zh-Hant-HK`, `zh-SG` to `zh-Hans-SG`).
 *
 * Portuguese ships as `pt-BR` only. A bare `pt` maximizes to `pt-Latn-BR` and
 * resolves here; so does `pt-PT`, which is a deliberate lossy match — the two
 * differ enough in software vocabulary to notice, and a second catalog is the
 * documented way out.
 *
 * Browser-safe: this module and everything reachable from it must import only
 * `zod`, other browser-safe core modules, and platform-neutral globals. No
 * `node:` builtins, no `process.env` — the renderer bundles it.
 */
export const SUPPORTED_LOCALES = [
  'en',
  'zh-Hans',
  'zh-Hant',
  'hi',
  'es',
  'ar',
  'fr',
  'bn',
  'pt-BR',
  'id',
  'ur',
] as const satisfies readonly string[];

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * The locales offered in the Settings language picker.
 *
 * Deliberately narrower than `SUPPORTED_LOCALES`: enumerated and selectable are
 * different states. A locale is enumerated from day one so the resolver, the
 * matcher and the font stack are exercised against the whole set instead of
 * being retrofitted, and it becomes selectable only once someone who reads it
 * has reviewed its catalog. Completeness is not the bar and never was: every
 * catalog here is full, and the ones outside this list are full of prose no
 * native speaker has read yet. Offering one is standing behind it.
 *
 * A stored preference naming an enumerated-but-unpromoted locale stays valid
 * and resolves normally — that is what lets a translator run the app in their
 * own language to check their own work.
 */
export const PICKER_LOCALES = ['en', 'es', 'zh-Hans'] as const satisfies readonly SupportedLocale[];

/**
 * The locales whose chrome layout is not finished.
 *
 * Both are right-to-left, and the chrome still lays out with physical margin,
 * padding and inset utilities rather than logical ones — so a right-to-left
 * base direction over it is visibly wrong rather than merely unpolished. Their
 * catalogs are complete and stay enumerated; what is unfinished is the layout
 * around the words.
 *
 * Reachable by an explicit stored preference and by the `OK_LANG` override, so
 * a contributor can still run the app in the language they are checking. What
 * they must not be is the language someone is dropped into because their
 * operating system happened to report it.
 */
export const LAYOUT_DEFERRED_LOCALES = ['ar', 'ur'] as const satisfies readonly SupportedLocale[];

const layoutDeferred = new Set<string>(LAYOUT_DEFERRED_LOCALES);

/**
 * The locales an OS or browser signal alone may land the chrome on.
 *
 * A stored preference is a choice; a platform signal is a guess, and a guess
 * must not put someone in a layout that is known to be wrong for them. Surfaces
 * with no chrome to lay out — a future localized CLI, say — want the whole
 * enumerated set here instead.
 */
export const AUTO_DETECTABLE_LOCALES: readonly SupportedLocale[] = SUPPORTED_LOCALES.filter(
  (locale) => !layoutDeferred.has(locale),
);

/**
 * What the language preference holds: an enumerated locale, or the sentinel
 * meaning "follow the operating system or browser".
 *
 * The sentinel is stored and transported unresolved. Resolving it to a concrete
 * tag anywhere before the point of activation freezes the preference at
 * whatever the OS happened to say once, and the app silently stops tracking it.
 */
export type LanguagePreference = 'system' | SupportedLocale;
