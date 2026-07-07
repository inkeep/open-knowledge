/**
 * Lazy loader for CodeMirror language packs used by the read-only
 * `TextViewer`. Each language pack is `import()`-ed on first request so
 * the main app bundle stays small — grammar payloads for languages no
 * one opens in a given session never reach the wire.
 *
 * Vite / Rollup tree-shakes each dynamic import into its own chunk; the
 * resolver memoizes per canonical ID so the second `.ts` file opened in
 * a session shares the already-loaded TypeScript pack.
 *
 * Returns `null` for canonical IDs that don't yet have a bundled CM
 * grammar — the viewer falls back to plain text in that case, same as
 * for unknown extensions.
 *
 * The canonical IDs match `CODE_BLOCK_LANGUAGES` in
 * `packages/app/src/editor/extensions/code-block-languages.ts` and the
 * `codeLanguageForExtension` lookup in
 * `@inkeep/open-knowledge-core`'s code-languages module.
 */

import type { Language } from '@codemirror/language';

const cache = new Map<string, Promise<Language | null>>();

/**
 * Return the CodeMirror `Language` instance for a canonical codeblock
 * language ID. Resolves to `null` when no language pack is wired up;
 * callers fall back to plain-text rendering.
 *
 * Memoized — repeated requests for the same canonical ID share the
 * underlying dynamic-import promise so the chunk is fetched at most once
 * per session.
 */
function loadCodeMirrorLanguage(canonical: string): Promise<Language | null> {
  const cached = cache.get(canonical);
  if (cached) return cached;
  const promise = resolveLanguage(canonical);
  cache.set(canonical, promise);
  return promise;
}

async function resolveLanguage(canonical: string): Promise<Language | null> {
  switch (canonical) {
    case 'bash':
    case 'shell':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/shell')).shell,
      );
    case 'c':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/clike')).c,
      );
    case 'cpp':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/clike')).cpp,
      );
    case 'csharp':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/clike')).csharp,
      );
    case 'css':
    case 'less':
    case 'scss':
      // `lang-css` doesn't ship dialect-specific grammars; the shared
      // CSS pack gracefully tolerates SCSS / LESS supersets at the
      // cost of mis-highlighting nesting / mixins in some edge cases.
      return (await import('@codemirror/lang-css')).css().language;
    case 'diff':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/diff')).diff,
      );
    case 'go':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/go')).go,
      );
    case 'ini':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/properties')).properties,
      );
    case 'java':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/clike')).java,
      );
    case 'javascript':
      return (await import('@codemirror/lang-javascript')).javascript().language;
    case 'json':
      return (await import('@codemirror/lang-json')).json().language;
    case 'kotlin':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/clike')).kotlin,
      );
    case 'lua':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/lua')).lua,
      );
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown().language;
    case 'objectivec':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/clike')).objectiveC,
      );
    case 'perl':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/perl')).perl,
      );
    case 'python':
      return (await import('@codemirror/lang-python')).python().language;
    case 'r':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/r')).r,
      );
    case 'ruby':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/ruby')).ruby,
      );
    case 'rust':
      return (await import('@codemirror/lang-rust')).rust().language;
    case 'sql':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/sql')).standardSQL,
      );
    case 'swift':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/swift')).swift,
      );
    case 'typescript':
      // Pass `{ typescript: true, jsx: true }` so `.ts` / `.tsx` files
      // get TS-aware highlighting (`interface`, generics, `as`).
      return (await import('@codemirror/lang-javascript')).javascript({
        typescript: true,
        jsx: true,
      }).language;
    case 'xml':
      return (await import('@codemirror/lang-html')).html().language;
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml().language;
    default:
      return null;
  }
}

/**
 * Same dispatch shape as the canonical-ID lookup but also handles the
 * `.canvas` / `.toml` extensions that aren't in `CODE_FILE_EXTENSIONS`:
 *   - `.canvas` — Obsidian canvas JSON; routed to JSON.
 *   - `.toml`   — legacy-modes shim (codeblock canonical is `ini`).
 *
 * Callers pass the lowercased extension + the canonical from
 * `codeLanguageForExtension`; either matches before plain-text fallback.
 */
export async function loadCodeMirrorLanguageForExtension(
  extension: string,
  canonical: string | null,
): Promise<Language | null> {
  if (extension === 'canvas') return (await import('@codemirror/lang-json')).json().language;
  if (canonical) {
    const lang = await loadCodeMirrorLanguage(canonical);
    if (lang) return lang;
  }
  if (extension === 'toml') {
    return (await import('@codemirror/language')).StreamLanguage.define(
      (await import('@codemirror/legacy-modes/mode/toml')).toml,
    );
  }
  return null;
}
