import type { TokensResult } from 'shiki/core';
import type {
  BundledLanguage,
  CodeHighlighterPlugin,
  HighlightOptions,
  ThemeInput,
} from 'streamdown';
import { okSyntaxTheme } from '@/lib/ok-syntax-theme';

const LANGUAGES: ReadonlyArray<{ id: string; aliases: readonly string[] }> = [
  { id: 'shellscript', aliases: ['bash', 'sh', 'shell', 'zsh'] },
  { id: 'tsx', aliases: ['typescript', 'ts', 'jsx'] },
  { id: 'javascript', aliases: ['js'] },
  { id: 'json', aliases: ['jsonc'] },
  { id: 'python', aliases: ['py'] },
  { id: 'rust', aliases: ['rs'] },
  { id: 'go', aliases: [] },
  { id: 'css', aliases: [] },
  { id: 'html', aliases: [] },
  { id: 'markdown', aliases: ['md'] },
  { id: 'yaml', aliases: ['yml'] },
  { id: 'toml', aliases: [] },
  { id: 'sql', aliases: [] },
  { id: 'diff', aliases: [] },
  { id: 'dockerfile', aliases: ['docker'] },
];

const CANONICAL = new Map<string, string>(
  LANGUAGES.flatMap((language) => [
    [language.id, language.id] as const,
    ...language.aliases.map((alias) => [alias, language.id] as const),
  ]),
);

const THEMES: [ThemeInput, ThemeInput] = [okSyntaxTheme, okSyntaxTheme];

const CACHE_LIMIT = 400;
const cache = new Map<string, TokensResult>();
const waiters = new Map<string, Set<(result: TokensResult) => void>>();

function cacheKey(code: string, language: string): string {
  return `${language}:${code.length}:${code.slice(0, 100)}:${code.length > 100 ? code.slice(-100) : ''}`;
}

export const codeHighlighter: CodeHighlighterPlugin = {
  name: 'shiki',
  type: 'code-highlighter',
  getSupportedLanguages: () => Array.from(CANONICAL.keys()) as BundledLanguage[],
  supportsLanguage: (language) => CANONICAL.has(language),
  getThemes: () => THEMES,
  highlight(options: HighlightOptions, callback?: (result: TokensResult) => void) {
    const language = CANONICAL.get(options.language) ?? 'text';
    const key = cacheKey(options.code, language);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    if (callback !== undefined) {
      const set = waiters.get(key) ?? new Set();
      set.add(callback);
      waiters.set(key, set);
    }
    import('./code-highlighter-impl')
      .then(async ({ tokenize }) => {
        const result = await tokenize(options.code, language);
        if (cache.size >= CACHE_LIMIT) {
          let toEvict = Math.floor(cache.size / 2);
          for (const staleKey of cache.keys()) {
            if (toEvict === 0) break;
            cache.delete(staleKey);
            toEvict -= 1;
          }
        }
        cache.set(key, result);
        const pending = waiters.get(key);
        if (pending !== undefined) {
          waiters.delete(key);
          for (const deliver of pending) deliver(result);
        }
      })
      .catch((error) => {
        waiters.delete(key);
        console.warn('[code-highlighter] highlight failed, leaving plain text', error);
      });
    return null;
  },
};
