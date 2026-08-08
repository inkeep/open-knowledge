/**
 * The interface language a bug report was filed in, recorded at both bundle
 * levels so a triager can tell which language the reporter was actually
 * reading.
 *
 * Three fields rather than one, because the obvious single value answers none
 * of the questions triage asks. `'system'` is the default and the most common
 * stored value, so a bundle carrying only the preference usually says nothing
 * at all; a bundle carrying only the resolved locale cannot tell a language the
 * user chose from one the OS handed them, which is the difference between "the
 * picker is broken" and "the resolver guessed". `source` names the tier that
 * decided, and `systemLanguages` is that tier's input — together they turn "the
 * app is in the wrong language" from a report into a diagnosis.
 *
 * Chrome only. The reporter's documents, titles, and frontmatter are in
 * whatever language they wrote them in, and nothing here describes those.
 *
 * Supplied through an injected seam for the same reason `readDesktopEnv` is:
 * the default below reads POSIX environment variables, which a macOS GUI app
 * does not have — an Electron host resolves against
 * `app.getPreferredSystemLanguages()` and injects the answer, so a desktop
 * bundle records the language on the reporter's screen rather than one derived
 * from an environment the app never consulted.
 */

import { homedir } from 'node:os';
import {
  AUTO_DETECTABLE_LOCALES,
  type LanguagePreference,
  type LocaleSource,
  resolveLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '@inkeep/open-knowledge-core';
import {
  type LocaleEnvironment,
  readConfigSafely,
  readNodeLocaleSignal,
  resolveConfigPath,
} from '@inkeep/open-knowledge-core/server';

export interface LanguageMetadata {
  /** `appearance.language` as stored — the setting as selected, `'system'` when unset. */
  preference: LanguagePreference;
  /** What that preference resolves to right now. */
  locale: SupportedLocale;
  /** Which resolution tier decided: an `OK_LANG` override, the stored choice, the OS list, or the fallback. */
  source: LocaleSource;
  /** The OS preferred-language list the `'system'` tier matched against, most-preferred first. */
  systemLanguages: readonly string[];
}

/**
 * Read `appearance.language` out of the user-scope config without throwing and
 * without sidelining the file.
 *
 * Fail-open on the same reasoning the sibling `resolveContentDir` uses: a
 * config that no longer parses may be the very thing being reported, and a
 * capture that refuses to run because of it takes away the evidence.
 *
 * The cost is that an unreadable file yields `'system'`, which is also the
 * unset default, so a corrupt user config reads at triage exactly like a
 * deliberate System choice. Nothing else in the bundle distinguishes them:
 * the collector stages the PROJECT `.ok/config.yml`, never this user-scope
 * file, and this reader is not on a logger. The desktop path does better —
 * it passes a real `warn` that lands in the staged desktop log — so the
 * ambiguity is confined to a shell-run capture over a config that no longer
 * parses. Surfacing it here would mean widening `LanguageMetadata` for that
 * narrow case; `source` plus `systemLanguages` already carry the resolution.
 */
function readStoredPreference(home: string): LanguagePreference {
  const absPath = resolveConfigPath('user', home, home);
  const result = readConfigSafely({ absPath, sideline: false, warn: () => {} });
  return result.value.appearance?.language ?? 'system';
}

/**
 * The CLI's own answer: the stored preference resolved against this process's
 * POSIX locale environment (`LC_ALL` / `LC_MESSAGES` / `LANG` / `LANGUAGE`) and
 * the `OK_LANG` override.
 *
 * Faithful for `ok bug-report` from a shell, which is the surface that has
 * those variables. The desktop app injects its own reader instead.
 */
export function defaultReadLanguage({
  home = homedir(),
  env = process.env,
}: {
  home?: string;
  env?: LocaleEnvironment;
} = {}): LanguageMetadata {
  const preference = readStoredPreference(home);
  const { override, preferenceList } = readNodeLocaleSignal(env);
  const { locale, source } = resolveLocale({
    override,
    storedPreference: preference,
    // The whole enumerated set: a preference naming a locale that is not yet
    // promoted to the picker still has to resolve here, or the bundle would
    // report a language the app is not in.
    supportedLocales: SUPPORTED_LOCALES,
    preferenceList,
    autoDetectableLocales: AUTO_DETECTABLE_LOCALES,
  });
  return { preference, locale, source, systemLanguages: preferenceList };
}
