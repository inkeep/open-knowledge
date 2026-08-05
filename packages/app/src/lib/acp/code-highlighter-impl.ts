/**
 * The heavy half of the code highlighter: shiki core, the JavaScript regex
 * engine (no oniguruma wasm), the curated grammars, and the github theme
 * pair. Loaded only via the dynamic import in `code-highlighter.ts` — a
 * static import from anywhere else would drag every grammar into the main
 * bundle and re-break the size budget. Grammar list must stay in sync with
 * `LANGUAGES` in `code-highlighter.ts`.
 */

// The TS-family grammars (typescript/tsx/javascript/jsx) are four ~190 kB
// near-copies; only tsx (a superset) and javascript ship — javascript comes
// with html anyway (html.mjs hard-imports it as an embedded grammar) — and
// the facade aliases the rest onto them.
import langCss from '@shikijs/langs/css';
import langDiff from '@shikijs/langs/diff';
import langDockerfile from '@shikijs/langs/dockerfile';
import langGo from '@shikijs/langs/go';
import langHtml from '@shikijs/langs/html';
import langJavascript from '@shikijs/langs/javascript';
import langJson from '@shikijs/langs/json';
import langMarkdown from '@shikijs/langs/markdown';
import langPython from '@shikijs/langs/python';
import langRust from '@shikijs/langs/rust';
import langShellscript from '@shikijs/langs/shellscript';
import langSql from '@shikijs/langs/sql';
import langToml from '@shikijs/langs/toml';
import langTsx from '@shikijs/langs/tsx';
import langYaml from '@shikijs/langs/yaml';
import themeGithubDark from '@shikijs/themes/github-dark';
import themeGithubLight from '@shikijs/themes/github-light';
import { createHighlighterCore, type HighlighterCore, type TokensResult } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  // The reset-on-rejection keeps a transient init failure from being cached
  // forever — `??=` would otherwise pin the rejected promise and disable
  // highlighting for the rest of the session.
  highlighterPromise ??= createHighlighterCore({
    themes: [themeGithubLight, themeGithubDark],
    langs: [
      langCss,
      langDiff,
      langDockerfile,
      langGo,
      langHtml,
      langJavascript,
      langJson,
      langMarkdown,
      langPython,
      langRust,
      langShellscript,
      langSql,
      langToml,
      langTsx,
      langYaml,
    ],
    // The JS engine skips the oniguruma wasm entirely; `forgiving` downgrades
    // an untranslatable grammar rule to plain tokens instead of throwing.
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }).catch((error: unknown) => {
    highlighterPromise = null;
    throw error;
  });
  return highlighterPromise;
}

/** Dual-theme token stream in the same shape `@streamdown/code` produced. */
export async function tokenize(code: string, language: string): Promise<TokensResult> {
  const highlighter = await getHighlighter();
  const resolved = highlighter.getLoadedLanguages().includes(language) ? language : 'text';
  return highlighter.codeToTokens(code, {
    lang: resolved,
    themes: { light: 'github-light', dark: 'github-dark' },
  });
}
