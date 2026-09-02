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
import { createHighlighterCore, type HighlighterCore, type TokensResult } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { OK_SYNTAX_THEME_NAME, okSyntaxTheme } from '@/lib/ok-syntax-theme';

let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [okSyntaxTheme],
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
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }).catch((error: unknown) => {
    highlighterPromise = null;
    throw error;
  });
  return highlighterPromise;
}

export async function tokenize(code: string, language: string): Promise<TokensResult> {
  const highlighter = await getHighlighter();
  const resolved = highlighter.getLoadedLanguages().includes(language) ? language : 'text';
  return highlighter.codeToTokens(code, { lang: resolved, theme: OK_SYNTAX_THEME_NAME });
}
