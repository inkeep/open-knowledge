/**
 * Streamdown code-highlighter plugin backed by shiki's fine-grained core
 * with a curated grammar set, replacing `@streamdown/code` — whose plugin
 * imports the full `shiki` bundle (every grammar and theme, ~1.8 MB gzipped
 * across chunks) and blew the app's all-chunks size budget. The heavy pieces
 * (engine, grammars, themes) live in `code-highlighter-impl.ts` behind a
 * dynamic import, so this module stays out of the main bundle's weight and
 * nothing loads until a fenced code block actually renders.
 *
 * Contract (streamdown's `CodeHighlighterPlugin`): `highlight` returns a
 * cached `TokensResult` synchronously when available, else null after
 * registering the callback — streamdown renders the plain fallback until the
 * callback delivers tokens.
 */

import type { TokensResult } from 'shiki/core';
import type {
  BundledLanguage,
  CodeHighlighterPlugin,
  HighlightOptions,
  ThemeInput,
} from 'streamdown';

/**
 * Fence labels mapped to the grammar the lazy impl actually loads. Ids must
 * stay in sync with the static imports in `code-highlighter-impl.ts`; an id
 * missing there falls back to plain text at tokenize time, never a crash.
 * The TS family collapses onto two grammars: tsx is a superset that
 * highlights plain TypeScript and JSX fine, and shipping all four near-copy
 * grammars costs ~140 kB gzipped for no visible difference.
 */
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

const THEMES: [ThemeInput, ThemeInput] = ['github-light', 'github-dark'];

// Streaming re-highlights the whole block on every appended chunk, so the
// cache sees one entry per growth step — bound it so a long session can't
// accumulate unboundedly. Key mirrors upstream: length + head/tail slices
// instead of the full text.
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
  // The configured pair, not the caller's request: tokenize always renders
  // github-light/github-dark (the only themes the lazy impl loads).
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
        // Evict the oldest half (Map iteration is insertion order) instead of
        // clearing — a full wipe re-tokenizes every visible block at once and
        // flashes them highlighted → plain → highlighted.
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
