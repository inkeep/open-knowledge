import { asBcp47Tag, type Bcp47Tag } from './bcp47.ts';

export type LocaleEnvironment = Readonly<Record<string, string | undefined>>;

export interface NodeLocaleSignal {
  readonly override: Bcp47Tag | undefined;
  readonly preferenceList: readonly Bcp47Tag[];
}

export const LOCALE_OVERRIDE_ENV_VAR = 'OK_LANG';

const BASE_VARIABLES = ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const;

const LIST_VARIABLE = 'LANGUAGE';

function posixToBcp47(value: string): Bcp47Tag | null {
  const language = value.trim().split('@')[0].split('.')[0];
  if (language === '' || language === 'C' || language === 'POSIX') return null;
  return asBcp47Tag(language.replaceAll('_', '-'));
}

function readBaseTag(env: LocaleEnvironment): Bcp47Tag | null {
  for (const variable of BASE_VARIABLES) {
    const value = env[variable]?.trim();
    if (value === undefined || value === '') continue;
    return posixToBcp47(value);
  }
  return null;
}

function readOverride(env: LocaleEnvironment): Bcp47Tag | undefined {
  const value = env[LOCALE_OVERRIDE_ENV_VAR]?.trim();
  if (value === undefined || value === '') return undefined;
  return asBcp47Tag(value) ?? undefined;
}

export function readNodeLocaleSignal(env: LocaleEnvironment = process.env): NodeLocaleSignal {
  const override = readOverride(env);
  const base = readBaseTag(env);
  if (base === null) return { override, preferenceList: [] };

  const listed: Bcp47Tag[] = [];
  const rawList = env[LIST_VARIABLE];
  if (rawList !== undefined) {
    for (const entry of rawList.split(':')) {
      const tag = posixToBcp47(entry);
      if (tag !== null) listed.push(tag);
    }
  }

  return { override, preferenceList: [...listed, base] };
}
