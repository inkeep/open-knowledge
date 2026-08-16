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
  'ko',
] as const satisfies readonly string[];

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * The locales offered in the Settings language picker.
 *
 * Every enumerated locale whose chrome layout is finished, which today is all
 * of them but the two right-to-left ones.
 *
 * A complete catalog is what earns a place here. Being unread does not hold a
 * language back: nobody on this project reads most of these, so waiting for a
 * native review before offering one means the people who could correct it can
 * never encounter it in the first place. Shipping it is what puts it in front
 * of the readers it needs, and corrections come back through the public
 * translation page rather than through a gate nobody can open.
 *
 * What that does not do is turn machine translation into reviewed translation.
 * Which languages a reader has actually read stays recorded, honestly and
 * separately, in `packages/app/src/locales/REVIEW.md`.
 *
 * A stored preference naming a locale held out of this tuple still resolves
 * normally — that is what lets a contributor run the app in the language they
 * are checking.
 */
export const PICKER_LOCALES = [
  'en',
  'zh-Hans',
  'zh-Hant',
  'hi',
  'es',
  'fr',
  'bn',
  'pt-BR',
  'id',
  'ko',
] as const satisfies readonly SupportedLocale[];

/**
 * The locales whose chrome layout is not finished.
 *
 * Both are right-to-left. Setting `dir="rtl"` does mirror the bulk of the
 * chrome — the shell is flex and grid, which follow the writing mode on their
 * own — so what is left is a set of specific defects rather than a wholesale
 * retrofit, and `REVIEW.md` carries the measured inventory. They are enough to
 * be worth holding for: text that reads left-aligned inside a right-to-left
 * pane, `ml-auto` spacers that push to the near edge instead of the far one,
 * arrows and disclosure chevrons that keep pointing the way they did, and
 * `tracking-*` on section headings, which pulls Arabic letters apart at the
 * joins and is the most visible of the lot.
 *
 * A green `pnpm check` is not evidence against this. The logical-property lint
 * rule carries a documented pre-rule backlog — a file-level `biome-ignore-all`
 * on the chrome files that predate it — and the shadcn primitives under
 * `components/ui/` are exempt from it entirely.
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
