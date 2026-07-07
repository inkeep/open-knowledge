import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { LanguageDescription } from '@codemirror/language';

/**
 * Hand-written allowlist of fenced-code languages for CM6 nested syntax highlighting.
 * Each entry uses a lazy `load()` so only the grammars actually encountered in the doc
 * are fetched — avoids the 150+ Vite chunks that `@codemirror/language-data` would emit.
 */
export const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({
    name: 'javascript',
    alias: ['js', 'jsx'],
    extensions: ['js', 'mjs', 'cjs', 'jsx'],
    load: async () => javascript({ jsx: true }),
  }),
  LanguageDescription.of({
    name: 'typescript',
    alias: ['ts', 'tsx'],
    extensions: ['ts', 'mts', 'cts', 'tsx'],
    load: async () => javascript({ typescript: true, jsx: true }),
  }),
  LanguageDescription.of({
    name: 'json',
    alias: ['jsonc'],
    extensions: ['json', 'jsonc'],
    load: () => import('@codemirror/lang-json').then((m) => m.json()),
  }),
  LanguageDescription.of({
    name: 'yaml',
    alias: ['yml'],
    extensions: ['yaml', 'yml'],
    load: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  }),
  LanguageDescription.of({
    name: 'css',
    alias: ['scss', 'less'],
    extensions: ['css', 'scss', 'less'],
    load: async () => css(),
  }),
  LanguageDescription.of({
    name: 'html',
    alias: ['htm'],
    extensions: ['html', 'htm'],
    load: async () => html(),
  }),
  LanguageDescription.of({
    name: 'python',
    alias: ['py'],
    extensions: ['py', 'pyw'],
    load: () => import('@codemirror/lang-python').then((m) => m.python()),
  }),
  LanguageDescription.of({
    name: 'rust',
    alias: ['rs'],
    extensions: ['rs'],
    load: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  }),
  LanguageDescription.of({
    name: 'markdown',
    alias: ['md', 'mdx'],
    extensions: ['md', 'mdx', 'markdown'],
    load: async () => markdown(),
  }),
  LanguageDescription.of({
    name: 'bash',
    alias: ['sh', 'shell', 'zsh'],
    extensions: ['sh', 'bash', 'zsh'],
    load: async () => {
      const [{ StreamLanguage, LanguageSupport }, { shell }] = await Promise.all([
        import('@codemirror/language'),
        import('@codemirror/legacy-modes/mode/shell'),
      ]);
      return new LanguageSupport(StreamLanguage.define(shell));
    },
  }),
  LanguageDescription.of({
    name: 'go',
    alias: ['golang'],
    extensions: ['go'],
    load: async () => {
      const [{ StreamLanguage, LanguageSupport }, { go }] = await Promise.all([
        import('@codemirror/language'),
        import('@codemirror/legacy-modes/mode/go'),
      ]);
      return new LanguageSupport(StreamLanguage.define(go));
    },
  }),
  LanguageDescription.of({
    // Source-mode highlight for ` ```math ` fences. The MathFence compat
    // descriptor parses these to <Math>; while authors edit in source mode,
    // CodeMirror reads the `math` info-string and dispatches to stex (LaTeX)
    // for syntax highlight inside the fence.
    name: 'math',
    alias: ['latex', 'tex'],
    extensions: ['tex', 'latex'],
    load: async () => {
      const [{ StreamLanguage, LanguageSupport }, { stex }] = await Promise.all([
        import('@codemirror/language'),
        import('@codemirror/legacy-modes/mode/stex'),
      ]);
      return new LanguageSupport(StreamLanguage.define(stex));
    },
  }),
];
