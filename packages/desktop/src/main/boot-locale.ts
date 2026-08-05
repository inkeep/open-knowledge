/**
 * Locale resolution for the main process.
 *
 * Main cannot wait for a renderer: the application menu is built inside
 * `runBootstrap`, before any BrowserWindow exists. So unlike the theme bridge —
 * which is push-only renderer→main and gets away with a hardcoded `'system'`
 * default until the first push lands — main reads the persisted user preference
 * off disk itself and resolves it against the OS preferred-language list. An
 * IPC-only design would put an English menu bar on every cold start.
 *
 * The stored value stays unresolved (`'system'` | a supported tag) on disk and
 * across IPC; the concrete locale exists only here, at the point of activation.
 * Resolving earlier would freeze a preference that is meant to keep following
 * the OS.
 *
 * Pure over injected deps: every read (disk, Electron, environment) arrives as
 * a function so the whole chain is unit-testable without an Electron runtime.
 */

import {
  AUTO_DETECTABLE_LOCALES,
  asBcp47Tag,
  type LanguagePreference,
  resolveLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
  toBcp47Tags,
} from '@inkeep/open-knowledge-core';
import {
  LOCALE_OVERRIDE_ENV_VAR,
  readConfigSafely,
  resolveConfigPath,
} from '@inkeep/open-knowledge-core/server';
import { getLogger } from './desktop-logger.ts';

export interface DesktopLocaleDeps {
  /** `os.homedir()` — the `~/.ok/global.yml` the user-scope layer writes. */
  readonly homedir: string;
  /** `app.getPreferredSystemLanguages()`. Electron's own recommendation for
   *  "deciding what language to present the application in"; already BCP 47. */
  readonly preferredSystemLanguages: () => readonly string[];
  /**
   * `process.env`, injected so the override tier is testable. It carries
   * `OK_LANG`, which reaches any *enumerated* locale — promoted to the picker
   * or not, layout finished or not — so a contributor can run the app in the
   * language they are checking.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Read `appearance.language` out of `~/.ok/global.yml` without throwing and
 * without sidelining the file. A corrupt or absent config yields `'system'`,
 * which is also the unset default — the menu should never be the reason a boot
 * fails, and rewriting a user's config from a menu-label code path would be a
 * surprising side effect of building a menu.
 *
 * The degraded path still has to say so somewhere. Main has no DevTools, so a
 * user whose config stopped parsing would otherwise get an English menu bar
 * with nothing anywhere to explain it.
 */
export function readStoredLanguagePreference(
  homedir: string,
  warn: (message: string) => void = () => {},
): LanguagePreference {
  const absPath = resolveConfigPath('user', homedir, homedir);
  const result = readConfigSafely({ absPath, sideline: false, warn });
  return result.value.appearance?.language ?? 'system';
}

/** Resolve the locale the native chrome should render in, right now. */
export function resolveDesktopLocale(deps: DesktopLocaleDeps): SupportedLocale {
  const storedPreference = readStoredLanguagePreference(deps.homedir, (message) =>
    getLogger('boot-locale').warn({ message }, 'user config unreadable; menus fall back to system'),
  );
  const override = deps.env[LOCALE_OVERRIDE_ENV_VAR];
  return resolveDesktopLocaleFrom({
    storedPreference,
    override,
    preferredSystemLanguages: deps.preferredSystemLanguages(),
  });
}

/**
 * Resolve for a preference a renderer just pushed, rather than the one on disk.
 *
 * The renderer pushes the instant its config document changes, but that document
 * reaches `~/.ok/global.yml` through debounced persistence — so at push time the
 * file still holds the previous language and `resolveDesktopLocale` above would
 * answer with it. Every other tier is identical; only the stored-preference
 * input differs, which is what `resolveDesktopLocaleFrom` was split out for.
 *
 * Takes the preference UNRESOLVED so `'system'` keeps following the OS: the
 * platform list is re-read here on each call rather than frozen at push time.
 */
export function resolveDesktopLocaleForPushed(
  preference: LanguagePreference,
  deps: Omit<DesktopLocaleDeps, 'homedir'>,
): SupportedLocale {
  return resolveDesktopLocaleFrom({
    storedPreference: preference,
    override: deps.env[LOCALE_OVERRIDE_ENV_VAR],
    preferredSystemLanguages: deps.preferredSystemLanguages(),
  });
}

interface DesktopLocaleInputs {
  readonly storedPreference: LanguagePreference;
  readonly override: string | undefined;
  readonly preferredSystemLanguages: readonly string[];
}

/**
 * The pure half — the same four-tier policy every runtime shares, with
 * Electron's preferred-language list as the platform signal. Split out so the
 * IPC path can re-resolve a pushed preference without re-reading disk.
 */
export function resolveDesktopLocaleFrom(inputs: DesktopLocaleInputs): SupportedLocale {
  return resolveLocale({
    override: (inputs.override === undefined ? null : asBcp47Tag(inputs.override)) ?? undefined,
    storedPreference: inputs.storedPreference,
    preferenceList: toBcp47Tags(inputs.preferredSystemLanguages),
    supportedLocales: SUPPORTED_LOCALES,
    // The OS list is a guess, and the menu bar sits above the same unfinished
    // chrome layout the renderer does, so it declines the same guesses.
    autoDetectableLocales: AUTO_DETECTABLE_LOCALES,
  }).locale;
}
