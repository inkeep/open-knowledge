import { asBcp47Tag, type Bcp47Tag } from './bcp47.ts';

/**
 * Environment variables in the shape `process.env` supplies them.
 *
 * Structural rather than `NodeJS.ProcessEnv` so a caller can hand over a
 * literal, which is what keeps this provider a pure function of its input.
 */
export type LocaleEnvironment = Readonly<Record<string, string | undefined>>;

/** The two tiers a Node runtime can fill in for the shared resolver. */
export interface NodeLocaleSignal {
  readonly override: Bcp47Tag | undefined;
  readonly preferenceList: readonly Bcp47Tag[];
}

/**
 * The variable that forces an interface language, mirroring the .NET CLI's
 * `DOTNET_CLI_UI_LANGUAGE`. Holds a BCP 47 tag, not a POSIX id.
 *
 * Exported because the Electron main process reads it too, out of its own
 * environment rather than through this provider. It is a name users type, so
 * two runtimes spelling it independently is a way for them to disagree.
 */
export const LOCALE_OVERRIDE_ENV_VAR = 'OK_LANG';

/** POSIX `setlocale` precedence for the message category, strongest first. */
const BASE_VARIABLES = ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const;

/**
 * The GNU gettext extension. It is not part of the `setlocale` chain: it layers
 * on top of whatever the message category resolved to, and is ignored entirely
 * when that resolved to `C` or `POSIX` (man7.org locale(7)). It is also the
 * only POSIX-side signal carrying an ordered list, which is the shape the
 * resolver consumes — every other variable yields a single tag.
 */
const LIST_VARIABLE = 'LANGUAGE';

/**
 * Convert a POSIX locale id to a canonical BCP 47 tag, or `null` when it names
 * no language.
 *
 * This conversion is the reason the provider boundary exists. POSIX ids are the
 * one non-conforming signal in the system — `Intl` rejects `zh_TW.UTF-8` and
 * `es_ES@euro` with a `RangeError` — so forwarding one unconverted crashes the
 * matcher. `C` and `POSIX` are the more dangerous pair, because they name the
 * scripting locale rather than a language and `POSIX` canonicalizes *silently*
 * to a meaningless `posix` rather than failing; both are rejected by name.
 */
function posixToBcp47(value: string): Bcp47Tag | null {
  const language = value.trim().split('@')[0].split('.')[0];
  if (language === '' || language === 'C' || language === 'POSIX') return null;
  return asBcp47Tag(language.replaceAll('_', '-'));
}

/**
 * Resolve the message-category locale. The first variable that is *set* wins,
 * even when its value names no language.
 *
 * Falling through to the next variable on an unusable value would invert POSIX
 * precedence: `LC_ALL=C` alongside `LANG=fr_FR.UTF-8` means "no translation",
 * not "French".
 */
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

/**
 * Read the locale signals a Node process has: the CLI, the server, and the
 * Electron main process.
 *
 * Node-only — it reads `process.env`, so it is reachable through
 * `@inkeep/open-knowledge-core/server` and never through the browser-safe root
 * barrel. Everything it returns is canonical BCP 47, which is the whole
 * contract: the resolver stays a pure matcher that never learns POSIX exists.
 *
 * `env` is injected so the function is total on its input and testable without
 * touching the real environment.
 */
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
