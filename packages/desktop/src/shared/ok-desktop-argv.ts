import type { OkDesktopConfig, OkThemeSource } from './bridge-contract.ts';

export const LANGUAGE_PREFERENCE_ARG_NAME = 'language-preference';
export const THEME_PREFERENCE_ARG_NAME = 'theme-preference';

export function resolveOkDesktopMode(raw: string | undefined): OkDesktopConfig['mode'] {
  if (raw === 'navigator') return 'navigator';
  if (raw === 'terminal') return 'terminal';
  if (raw === 'note') return 'note';
  return 'editor';
}

export function resolveOkThemePreference(raw: string | undefined): OkThemeSource | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'light' || raw === 'dark') return raw;
  return 'system';
}
