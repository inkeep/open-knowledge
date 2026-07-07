import { describe, expect, test } from 'bun:test';
import {
  CODE_FILE_BARE_NAMES_TO_LANGUAGE,
  CODE_FILE_EXTENSIONS,
  CODE_FILE_EXTENSIONS_TO_LANGUAGE,
  codeLanguageForBareFilename,
  codeLanguageForExtension,
} from './code-languages';

describe('codeLanguageForExtension', () => {
  test('maps the canonical extensions to their codeblock language IDs', () => {
    expect(codeLanguageForExtension('ts')).toBe('typescript');
    expect(codeLanguageForExtension('tsx')).toBe('typescript');
    expect(codeLanguageForExtension('js')).toBe('javascript');
    expect(codeLanguageForExtension('py')).toBe('python');
    expect(codeLanguageForExtension('rs')).toBe('rust');
    expect(codeLanguageForExtension('go')).toBe('go');
    expect(codeLanguageForExtension('rb')).toBe('ruby');
    expect(codeLanguageForExtension('sh')).toBe('bash');
    expect(codeLanguageForExtension('cpp')).toBe('cpp');
    expect(codeLanguageForExtension('h')).toBe('c');
    expect(codeLanguageForExtension('hpp')).toBe('cpp');
    expect(codeLanguageForExtension('yaml')).toBe('yaml');
    expect(codeLanguageForExtension('xml')).toBe('xml');
    // `.json` must resolve so files like `config.json` / `.mcp.json` open
    // in the text viewer with the CodeMirror JSON grammar rather than
    // falling through to the unhighlighted plaintext branch.
    expect(codeLanguageForExtension('json')).toBe('json');
    // `.html` / `.htm` / `.svg` deliberately fall through to the
    // existing inline-render / image-fallback paths — see the
    // comment in `code-languages.ts` for the XSS / dispatch rationale.
    expect(codeLanguageForExtension('html')).toBeNull();
    expect(codeLanguageForExtension('htm')).toBeNull();
    expect(codeLanguageForExtension('svg')).toBeNull();
  });

  test('strips a leading dot from the extension input', () => {
    // Callers reach this helper from filename parsing where the leading
    // `.` is conventionally retained — both shapes must resolve.
    expect(codeLanguageForExtension('.ts')).toBe('typescript');
    expect(codeLanguageForExtension('.py')).toBe('python');
  });

  test('is case-insensitive', () => {
    expect(codeLanguageForExtension('TS')).toBe('typescript');
    expect(codeLanguageForExtension('PY')).toBe('python');
    expect(codeLanguageForExtension('Cpp')).toBe('cpp');
  });

  test('returns null for an unknown extension', () => {
    // The dispatch deliberately drops `txt` here so plain-text files
    // still fall through to the existing fallback render (no language
    // pack). The TextViewer's plaintext branch handles them.
    expect(codeLanguageForExtension('txt')).toBeNull();
    expect(codeLanguageForExtension('docx')).toBeNull();
    expect(codeLanguageForExtension('zip')).toBeNull();
    expect(codeLanguageForExtension('')).toBeNull();
  });

  test('aliases consolidate to the same canonical ID', () => {
    // Authors who type any of these in the codeblock picker get the
    // same lowlight grammar; opening the corresponding file in the
    // sidebar must pick the same CM language pack.
    const javascriptAliases = ['js', 'jsx', 'mjs', 'cjs'];
    for (const alias of javascriptAliases) {
      expect(codeLanguageForExtension(alias)).toBe('javascript');
    }

    const typescriptAliases = ['ts', 'tsx'];
    for (const alias of typescriptAliases) {
      expect(codeLanguageForExtension(alias)).toBe('typescript');
    }

    const bashAliases = ['sh', 'zsh', 'bash'];
    for (const alias of bashAliases) {
      expect(codeLanguageForExtension(alias)).toBe('bash');
    }

    const jsonAliases = ['json', 'jsonc'];
    for (const alias of jsonAliases) {
      expect(codeLanguageForExtension(alias)).toBe('json');
    }
  });
});

describe('codeLanguageForBareFilename', () => {
  test('Makefile (any case) resolves to makefile', () => {
    expect(codeLanguageForBareFilename('Makefile')).toBe('makefile');
    expect(codeLanguageForBareFilename('makefile')).toBe('makefile');
    expect(codeLanguageForBareFilename('MAKEFILE')).toBe('makefile');
  });

  test('Dockerfile resolves to bash (shell-shaped commands)', () => {
    expect(codeLanguageForBareFilename('Dockerfile')).toBe('bash');
    expect(codeLanguageForBareFilename('dockerfile')).toBe('bash');
  });

  test('Gemfile / Rakefile resolve to ruby', () => {
    expect(codeLanguageForBareFilename('Gemfile')).toBe('ruby');
    expect(codeLanguageForBareFilename('Rakefile')).toBe('ruby');
  });

  test('returns null for an unrecognized bare filename', () => {
    expect(codeLanguageForBareFilename('README')).toBeNull();
    expect(codeLanguageForBareFilename('LICENSE')).toBeNull();
  });
});

describe('CODE_FILE_EXTENSIONS — internal consistency', () => {
  test('every extension key resolves through codeLanguageForExtension', () => {
    // The exported Set is derived from the table's keys; verify the
    // membership probe matches the lookup helper exactly so a future
    // refactor that diverges them fails this test.
    for (const ext of CODE_FILE_EXTENSIONS) {
      expect(codeLanguageForExtension(ext)).not.toBeNull();
    }
  });

  test('every canonical language ID is present in CODE_BLOCK_LANGUAGES', () => {
    // Hard-coded mirror of `CODE_BLOCK_LANGUAGES[].value` — this keeps
    // the file-extension dispatch from drifting to a language ID the
    // editor's slash menu wouldn't recognize. Update both lists
    // together when adding a new language.
    const knownCanonical = new Set([
      'plaintext',
      'bash',
      'c',
      'cpp',
      'csharp',
      'css',
      'diff',
      'go',
      'graphql',
      'ini',
      'java',
      'javascript',
      'json',
      'kotlin',
      'less',
      'lua',
      'makefile',
      'markdown',
      'objectivec',
      'perl',
      'php',
      'python',
      'r',
      'ruby',
      'rust',
      'scss',
      'shell',
      'sql',
      'swift',
      'typescript',
      'xml',
      'yaml',
    ]);
    for (const lang of Object.values(CODE_FILE_EXTENSIONS_TO_LANGUAGE)) {
      expect(knownCanonical.has(lang)).toBe(true);
    }
    for (const lang of Object.values(CODE_FILE_BARE_NAMES_TO_LANGUAGE)) {
      expect(knownCanonical.has(lang)).toBe(true);
    }
  });
});
