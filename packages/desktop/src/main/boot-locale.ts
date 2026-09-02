import type { LanguageMetadata } from '@inkeep/open-knowledge';
import {
  AUTO_DETECTABLE_LOCALES,
  asBcp47Tag,
  type LanguagePreference,
  type LocaleResolution,
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
  readonly homedir: string;
  readonly preferredSystemLanguages: () => readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function readStoredLanguagePreference(
  homedir: string,
  warn: (message: string) => void = () => {},
): LanguagePreference {
  const absPath = resolveConfigPath('user', homedir, homedir);
  const result = readConfigSafely({ absPath, sideline: false, warn });
  return result.value.appearance?.language ?? 'system';
}

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

function resolveDesktopLocaleResolution(inputs: DesktopLocaleInputs): LocaleResolution {
  return resolveLocale({
    override: (inputs.override === undefined ? null : asBcp47Tag(inputs.override)) ?? undefined,
    storedPreference: inputs.storedPreference,
    preferenceList: toBcp47Tags(inputs.preferredSystemLanguages),
    supportedLocales: SUPPORTED_LOCALES,
    autoDetectableLocales: AUTO_DETECTABLE_LOCALES,
  });
}

export function resolveDesktopLocaleFrom(inputs: DesktopLocaleInputs): SupportedLocale {
  return resolveDesktopLocaleResolution(inputs).locale;
}

export function describeDesktopLanguage(
  deps: DesktopLocaleDeps & { readonly pushedPreference: LanguagePreference | null },
): LanguageMetadata {
  const storedPreference =
    deps.pushedPreference ??
    readStoredLanguagePreference(deps.homedir, (message) =>
      getLogger('boot-locale').warn(
        { message },
        'user config unreadable; bug report records the system fallback',
      ),
    );
  const preferredSystemLanguages = deps.preferredSystemLanguages();
  const { locale, source } = resolveDesktopLocaleResolution({
    storedPreference,
    override: deps.env[LOCALE_OVERRIDE_ENV_VAR],
    preferredSystemLanguages,
  });
  return {
    preference: storedPreference,
    locale,
    source,
    systemLanguages: preferredSystemLanguages,
  };
}
